#!/usr/bin/env node
// Representative replay, outage and security checks against the real Worker on workerd. Starts
// the same server Playwright uses, on its own fresh database. Everything is simulated: no real
// source is contacted. Usage: node scripts/connector-proof.mjs [evidence.json]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";

const base = "http://127.0.0.1:8788";
const server = spawn("node", ["scripts/e2e-server.mjs"], { stdio: "ignore", detached: true });
const stop = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
};
process.on("exit", stop);

const wait = async () => {
  for (let i = 0; i < 180; i++) {
    const up = await fetch(`${base}/health/live`).catch(() => null);
    if (up?.ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start");
};

let cookie = "";
const call = async (path, { method = "GET", body, key } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === "GET" ? {} : { origin: base, "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: res.status, json: await res.json().catch(() => null) };
};

let n = 0;
const key = () => `proof-${Date.now()}-${n++}`;
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
  console.log(`${ok ? "pass" : "FAIL"}  ${name}`);
};

await wait();
await call("/api/v1/demo/sessions", { method: "POST" });
await call("/api/v1/demo/role", { method: "POST", body: { role: "manager" } });
const list = (await call("/api/v1/integrations")).json.items;
const source = (p) => list.find((s) => s.provider === p);
const erp = source("erp_simulator");
const sync = (id, body = {}) =>
  call(`/api/v1/integrations/${id}/sync`, { method: "POST", key: key(), body });

const db = new pg.Client({
  connectionString: "postgres://opsbridge_migrator:local_dev_only@127.0.0.1:54330/opsbridge_e2e",
});
await db.connect();
const sessionWs = (
  await db.query("SELECT workspace_id FROM app.external_connections WHERE id = $1", [erp.id])
).rows[0].workspace_id;
const tables = [
  "customers",
  "invoices",
  "source_records",
  "external_record_links",
  "reconciliation_findings",
  "inventory_snapshots",
];
const snapshot = async () => {
  const out = {};
  for (const t of tables) {
    out[t] = (
      await db.query(`SELECT count(*)::int AS n FROM app.${t} WHERE workspace_id = $1`, [sessionWs])
    ).rows[0].n;
  }
  return out;
};

for (const p of ["crm_simulator", "erp_simulator", "inventory_simulator"]) {
  const run = await sync(source(p).id);
  check(`first sync ${p}`, run.json.status === "succeeded", run.json.counts);
}
const first = await snapshot();
for (const p of ["crm_simulator", "erp_simulator", "inventory_simulator"]) {
  const run = await sync(source(p).id, { full: true });
  check(
    `full replay ${p} adds nothing`,
    run.json.counts.created === 0 && run.json.counts.findings_opened === 0,
    run.json.counts,
  );
}
const second = await snapshot();
check("P3-B row counts equal after replay", JSON.stringify(first) === JSON.stringify(second), {
  first,
  second,
});

const outage = await sync(erp.id, { scenario: "http_5xx_outage" });
check(
  "outage fails with the cursor saved",
  outage.json.status === "failed" && outage.json.cursorSaved,
  outage.json.error,
);
const degraded = (await call("/api/v1/integrations")).json.items.find((s) => s.id === erp.id);
check("connection degraded", degraded.status === "Degraded");
check(
  "the demo still reads cases during an outage",
  (await call("/api/v1/cases?limit=1")).status === 200,
);
const resumed = await call(`/api/v1/integrations/${erp.id}/runs/${outage.json.id}/resume`, {
  method: "POST",
  body: {},
});
check(
  "resume finishes from the saved cursor",
  resumed.json.status === "succeeded" && resumed.json.resumes === 1,
  resumed.json.counts,
);
check(
  "P3-B row counts equal after outage and resume",
  JSON.stringify(await snapshot()) === JSON.stringify(first),
);

const revoked = await sync(erp.id, { scenario: "http_401" });
check(
  "401 dead letter, no provider text",
  revoked.json.status === "dead_letter" && !JSON.stringify(revoked.json).includes("INVALID_LOGIN"),
  revoked.json.error,
);

const listAll = await call("/api/v1/integrations");
check("no secret fields in a response", !/secret|token|lease/i.test(JSON.stringify(listAll.json)));
check(
  "a guest gets no admin route",
  (
    await call(`/api/v1/admin/integrations/${erp.id}/sync`, {
      method: "POST",
      key: key(),
      body: {},
    })
  ).status === 404,
);
check("unknown scenario refused", (await sync(erp.id, { scenario: "drop_tables" })).status === 400);
await call("/api/v1/demo/role", { method: "POST", body: { role: "viewer" } });
check("a viewer can't sync", (await sync(erp.id)).status === 403);
check(
  "no live connection exists in any demo workspace",
  (
    await db.query(
      "SELECT count(*)::int AS n FROM app.external_connections c JOIN app.workspaces w ON w.id = c.workspace_id WHERE c.mode <> 'simulated' AND w.mode = 'demo'",
    )
  ).rows[0].n === 0,
);
await db.end();

const failed = checks.filter((c) => !c.ok);
const report = {
  ranAt: new Date().toISOString(),
  runtime: "wrangler dev, workerd, Docker Postgres, simulated sources only",
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
};
const out = process.argv[2];
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`${report.passed} passed, ${report.failed} failed`);
stop();
process.exit(failed.length ? 1 : 0);
