#!/usr/bin/env node
// P7.3: local restore drill (E2E-23, local half). Takes a backup, damages the source the way a
// bad migration or operator mistake would, restores the backup into a new database, proves the
// restored data matches the backup point exactly and differs from the damaged source, then runs
// the real Worker on the restored copy and smoke-tests it. Timings are the local recovery
// measurement. Docker Postgres only; the source must be a disposable *_test database.
//   node scripts/restore-drill.mjs [source-db]     default opsbridge_rollback_test
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const SRC = process.argv[2] ?? "opsbridge_rollback_test";
if (!/^opsbridge_[a-z0-9_]+_test$/.test(SRC))
  throw new Error("source must be a disposable *_test database");
const DST = `${SRC}_recovered`;
const CTR = "opsbridge-postgres";
const PORT = 8793;
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const admin = (db) => `postgres://opsbridge_admin:local_dev_only@127.0.0.1:54330/${db}`;
const conn = (role) => `postgres://${role}:local_dev_only@127.0.0.1:54330/${DST}?sslmode=disable`;
const OWNER = "00000000-0000-4000-8000-000000000002";
const lines = [];
const say = (s) => {
  console.log(s);
  lines.push(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => execFileSync("docker", ["exec", CTR, ...args], { encoding: "utf8" });
const timed = async (fn) => {
  const t = Date.now();
  const out = await fn();
  return [out, Date.now() - t];
};

async function fingerprint(db) {
  const c = new pg.Client({ connectionString: admin(db) });
  await c.connect();
  try {
    const { rows: tables } = await c.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'app' ORDER BY 1",
    );
    const out = {};
    for (const { tablename: t } of tables) {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM app.${t} x`,
      );
      out[t] = `${rows[0].n}:${rows[0].h}`;
    }
    const m = await c.query(
      "SELECT string_agg(version, ',' ORDER BY version) AS v FROM ops.schema_migrations",
    );
    out["ops.schema_migrations"] = m.rows[0].v;
    return out;
  } finally {
    await c.end();
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

say(`# Local restore drill, ${new Date().toISOString()}, source ${SRC}`);
const before = await fingerprint(SRC);
const rows = Object.entries(before)
  .filter(([k]) => k !== "ops.schema_migrations")
  .reduce((n, [, v]) => n + Number(v.split(":")[0]), 0);
say(
  `backup point: ${Object.keys(before).length - 1} tables, ${rows} rows, migrations ${before["ops.schema_migrations"].split(",").at(-1)}`,
);

const [, dumpMs] = await timed(() =>
  docker("pg_dump", "-U", "opsbridge_admin", "-d", SRC, "-Fc", "-f", "/tmp/drill.dump"),
);
const bytes = docker("stat", "-c", "%s", "/tmp/drill.dump").trim();
say(`backup: pg_dump -Fc, ${bytes} bytes, ${dumpMs} ms`);

// The damage: what a bad release could do. The admin role bypasses RLS, as a migration would.
const damage = new pg.Client({ connectionString: admin(SRC) });
await damage.connect();
await damage.query("BEGIN");
await damage.query("ALTER TABLE app.cases DISABLE TRIGGER USER");
const hit = await damage.query(
  "UPDATE app.cases SET title = 'DAMAGED BY DRILL' WHERE workspace_id = $1",
  [OWNER],
);
await damage.query("ALTER TABLE app.cases ENABLE TRIGGER USER");
const gone = await damage.query("DELETE FROM app.metric_snapshots");
await damage.query("COMMIT");
await damage.end();
say(
  `damage: ${hit.rowCount} owner case titles overwritten, ${gone.rowCount} metric snapshots deleted`,
);
const damaged = await fingerprint(SRC);
say(`${same(damaged, before) ? "FAIL" : "PASS"} the source no longer matches the backup point`);

const [, restoreMs] = await timed(async () => {
  const c = new pg.Client({ connectionString: admin("postgres") });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${DST} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${DST}`);
  await c.end();
  docker("pg_restore", "-U", "opsbridge_admin", "-d", DST, "--exit-on-error", "/tmp/drill.dump");
});
docker("rm", "-f", "/tmp/drill.dump");
say(`restore: pg_restore into ${DST}, ${restoreMs} ms`);
const recovered = await fingerprint(DST);
const diff = Object.keys(before).filter((k) => before[k] !== recovered[k]);
say(
  `${diff.length === 0 ? "PASS" : "FAIL"} restored data equals the backup point in every table${diff.length ? `: ${diff.join(", ")}` : ""}`,
);

// Grants travel in the dump; role passwords and CONNECT live on the cluster.
const g = new pg.Client({ connectionString: admin(DST) });
await g.connect();
await g.query(
  `GRANT CONNECT ON DATABASE ${DST} TO opsbridge_app, opsbridge_cleanup, opsbridge_dispatcher`,
);
await g.end();

const vars = join(repo, ".wrangler", "drill.vars");
writeFileSync(vars, "IP_HASH_KEY=drill-only-not-a-secret\n");
const t0 = Date.now();
const child = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--port",
    String(PORT),
    "--inspector-port",
    String(PORT + 1000),
    "--env-file",
    vars,
  ],
  {
    cwd: repo,
    stdio: "ignore",
    env: {
      ...process.env,
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: conn("opsbridge_app"),
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CLEANUP: conn("opsbridge_cleanup"),
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_DISPATCH:
        conn("opsbridge_dispatcher"),
    },
  },
);
for (;;) {
  try {
    if ((await fetch(`http://localhost:${PORT}/health/ready`)).ok) break;
  } catch {}
  if (Date.now() - t0 > 60_000) throw new Error("worker did not start");
  await sleep(250);
}
const readyMs = Date.now() - t0;
const smoke = spawnSync("node", ["scripts/smoke.mjs", `http://localhost:${PORT}`], {
  cwd: repo,
  encoding: "utf8",
});
child.kill("SIGTERM");
await new Promise((r) => child.once("exit", r));
const passed = (smoke.stdout.match(/^PASS/gm) ?? []).length;
const smokeMs = Date.now() - t0;
say(
  `${smoke.status === 0 ? "PASS" : "FAIL"} Worker on the restored copy: ready after ${readyMs} ms, smoke ${passed} checks passed`,
);
say(
  `recovery work, backup plus restore plus Worker up and smoke: ${dumpMs + restoreMs + smokeMs} ms (local machine, excludes a person noticing and deciding)`,
);

const ok = !lines.some((l) => l.startsWith("FAIL"));
say(ok ? "DRILL PASSED" : "DRILL FAILED");
writeFileSync(join(repo, "docs/evidence/P7.3/restore-drill.txt"), `${lines.join("\n")}\n`);
process.exit(ok ? 0 : 1);
