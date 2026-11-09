#!/usr/bin/env node
// P7.3: local release and rollback rehearsal (E2E-24, local half). Runs two real Workers under
// wrangler dev against one throwaway database: the previous release, unpacked from git with
// `git archive` (no worktree, nothing written to .git), and this checkout. Walks the release
// order from docs/runbooks/RELEASE-ROLLBACK.md and records what works at each step:
//   1. previous release on its own schema
//   2. expand migration (--to 0010), then this release
//   3. rollback: previous release on the expanded schema
//   4. roll forward, then the contract migration (0011)
//   5. what a rollback after the contract would cost: previous release on the contracted schema
// Every step runs scripts/smoke.mjs and checks that a new case's outbox event gets dispatched.
// Local only. Nothing here touches a host.
//   node scripts/rollback-rehearsal.mjs [previous-ref]     default 48eac5d (accepted P6 head)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localUrl, migrate, relaxLimits, seed, setupLocal } from "./db.mjs";

const PREVIOUS = process.argv[2] ?? "48eac5d";
const DB = "opsbridge_rollback_test";
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const conn = (role) => `postgres://${role}:local_dev_only@127.0.0.1:54330/${DB}?sslmode=disable`;
const migratorUrl = localUrl("opsbridge_migrator", DB);
const lines = [];
const say = (s) => {
  console.log(s);
  lines.push(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unpackPrevious() {
  const dir = mkdtempSync(join(tmpdir(), "opsbridge-previous-"));
  const tar = spawnSync("git", ["archive", "--format=tar", PREVIOUS], { maxBuffer: 1 << 30 });
  if (tar.status !== 0) throw new Error(`git archive ${PREVIOUS} failed`);
  spawnSync("tar", ["-x", "-C", dir], { input: tar.stdout });
  // Same dependency versions in both releases (package-lock.json unchanged since P6).
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
  return dir;
}

function build(dir) {
  const r = spawnSync("npx", ["vite", "build", "--config", "frontend/vite.config.ts"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`build failed in ${dir}: ${r.stderr}`);
}

async function startWorker(dir, port) {
  const vars = join(dir, ".rehearsal.vars");
  writeFileSync(vars, "IP_HASH_KEY=rehearsal-only-not-a-secret\n");
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--port",
      String(port),
      "--inspector-port",
      String(port + 1000),
      "--env-file",
      vars,
    ],
    {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: conn("opsbridge_app"),
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CLEANUP: conn("opsbridge_cleanup"),
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_DISPATCH:
          conn("opsbridge_dispatcher"),
      },
    },
  );
  const started = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://localhost:${port}/health/live`);
      if (r.ok) break;
    } catch {}
    if (Date.now() - started > 60_000) throw new Error(`worker on ${port} did not start`);
    await sleep(250);
  }
  return { child, ms: Date.now() - started };
}

async function stopWorker(w) {
  w.child.kill("SIGTERM");
  await new Promise((r) => w.child.once("exit", r));
}

function smoke(port) {
  const r = spawnSync("node", ["scripts/smoke.mjs", `http://localhost:${port}`], {
    cwd: repo,
    encoding: "utf8",
  });
  const passed = (r.stdout.match(/^PASS/gm) ?? []).length;
  const failed = (r.stdout.match(/^FAIL/gm) ?? []).length;
  return { ok: r.status === 0, passed, failed };
}

// Launch a guest, create a case, and wait for its case.created event to leave Pending.
async function dispatchWorks(port) {
  const base = `http://localhost:${port}`;
  const launch = await fetch(`${base}/api/v1/demo/sessions`, {
    method: "POST",
    headers: { origin: base },
  });
  const cookie = (launch.headers.get("set-cookie") ?? "").split(";")[0];
  const customers = await (await fetch(`${base}/api/v1/customers`, { headers: { cookie } })).json();
  const res = await fetch(`${base}/api/v1/cases`, {
    method: "POST",
    headers: {
      cookie,
      origin: base,
      "content-type": "application/json",
      "idempotency-key": `rehearsal-${Date.now()}-${Math.random()}`,
    },
    body: JSON.stringify({
      title: "Rollback rehearsal case",
      customerId: customers.items[0].id,
      caseType: "Onboarding",
    }),
  });
  if (res.status !== 201) return { ok: false, state: `create ${res.status}` };
  // The guest's own runs, newest first. Seeded pack events are already settled, so the newest
  // case.created run is the one this request made.
  let state = "none";
  for (let i = 0; i < 40; i++) {
    const runs = await (
      await fetch(`${base}/api/v1/automations/runs?limit=50`, { headers: { cookie } })
    ).json();
    const mine = (runs.items ?? [])
      .filter((r) => r.type === "case.created")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    state = mine?.dispatchState ?? "none";
    if (!["none", "pending", "processing"].includes(state)) break;
    await sleep(250);
  }
  return { ok: state === "simulated", state };
}

async function step(name, dir, port) {
  const t0 = Date.now();
  const w = await startWorker(dir, port);
  const s = smoke(port);
  const d = await dispatchWorks(port);
  await stopWorker(w);
  say(
    `${name}: start ${w.ms} ms, smoke ${s.ok ? "PASS" : "FAIL"} (${s.passed} passed, ${s.failed} failed), dispatch ${d.ok ? "works" : "STALLED"} (${d.state}), step ${Date.now() - t0} ms`,
  );
  return { smoke: s.ok, dispatch: d.ok };
}

const applied = async (to) => (await migrate(migratorUrl, to ? { to } : {})).join(", ") || "none";

say(`# Local release and rollback rehearsal, ${new Date().toISOString()}`);
say(`previous release ${PREVIOUS}, this release ${head}, database ${DB}, node ${process.version}`);
const prev = unpackPrevious();
const results = {};
try {
  build(prev);
  build(repo);
  await setupLocal(DB, { recreate: true });
  say(`schema at previous release: applied ${await applied("0009")}`);
  await seed(migratorUrl);
  await relaxLimits(migratorUrl);
  results.previous = await step("1 previous release on 0009", prev, 8791);
  say(`release, expand: applied ${await applied("0010")}`);
  results.release = await step("2 this release on 0010", repo, 8792);
  results.rollback = await step("3 ROLLBACK: previous release on 0010", prev, 8791);
  results.forward = await step("4a roll forward: this release on 0010", repo, 8792);
  say(`next release, contract: applied ${await applied()}`);
  results.contract = await step("4b this release on 0011", repo, 8792);
  results.late = await step("5 previous release on 0011 (rollback past the contract)", prev, 8791);
} finally {
  rmSync(prev, { recursive: true, force: true });
}

const expect = (label, ok) => say(`${ok ? "PASS" : "FAIL"} ${label}`);
expect(
  "previous release works on its own schema",
  results.previous.smoke && results.previous.dispatch,
);
expect(
  "this release works after the expand migration",
  results.release.smoke && results.release.dispatch,
);
expect(
  "rollback to the previous release works on the expanded schema (E2E-24)",
  results.rollback.smoke && results.rollback.dispatch,
);
expect(
  "this release works after the contract migration",
  results.contract.smoke && results.contract.dispatch,
);
expect(
  "after the contract, the previous release still serves visitors but can't dispatch (why 0011 ships a release later)",
  results.late.smoke && !results.late.dispatch,
);
const ok = lines.filter((l) => l.startsWith("FAIL")).length === 0;
say(ok ? "REHEARSAL PASSED" : "REHEARSAL FAILED");
writeFileSync(join(repo, "docs/evidence/P7.3/rollback-rehearsal.txt"), `${lines.join("\n")}\n`);
process.exit(ok ? 0 : 1);
