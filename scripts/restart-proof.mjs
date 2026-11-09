#!/usr/bin/env node
// P2-A. Writes through the real Worker on workerd, stops the Worker, restarts Postgres and a new
// Worker, then proves every record and the session are still there. Local Docker only.
// Leaves opsbridge_restart_test behind so scripts/restore-proof.sh can use its real history.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { localUrl, migrate, relaxLimits, seed, setupLocal } from "./db.mjs";

const DB = "opsbridge_restart_test";
const PORT = "8799";
const BASE = `http://localhost:${PORT}`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const note = (line) => {
  console.log(line);
  lines.push(line);
};

await setupLocal(DB, { recreate: true });
await migrate(localUrl("opsbridge_migrator", DB));
await seed(localUrl("opsbridge_migrator", DB));
await relaxLimits(localUrl("opsbridge_migrator", DB));

mkdirSync(".wrangler/restart", { recursive: true });
writeFileSync(".wrangler/restart/dev.vars", "IP_HASH_KEY=restart-proof-not-a-secret\n");
const conn = (role) => `postgres://${role}:local_dev_only@127.0.0.1:54330/${DB}?sslmode=disable`;

async function startWorker() {
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--port",
      PORT,
      "--inspector-port",
      "9241",
      "--env-file",
      ".wrangler/restart/dev.vars",
    ],
    {
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: conn("opsbridge_app"),
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CLEANUP: conn("opsbridge_cleanup"),
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_DISPATCH:
          conn("opsbridge_dispatcher"),
      },
    },
  );
  for (let i = 0; i < 120; i++) {
    if (
      await fetch(`${BASE}/health/live`).then(
        (r) => r.ok,
        () => false,
      )
    )
      return child;
    await pause(500);
  }
  throw new Error("Worker did not start");
}

async function stopWorker(child) {
  process.kill(-child.pid, "SIGTERM");
  for (let i = 0; i < 40; i++) {
    if (
      await fetch(`${BASE}/health/live`).then(
        () => false,
        () => true,
      )
    )
      return;
    await pause(250);
  }
  process.kill(-child.pid, "SIGKILL");
}

let cookie = "";
async function api(path, { method = "GET", body, key } = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === "GET" ? {} : { origin: BASE }),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const snapshot = async (ids) => {
  const list = await api("/cases?limit=100");
  const details = {};
  for (const id of ids) {
    details[id] = await api(`/cases/${id}`);
    details[id].activity = (await api(`/cases/${id}/activity`)).items;
  }
  // Age is measured from now, so it may tick over. Everything else must match exactly.
  const stable = (v) => JSON.stringify(v, (k, x) => (k === "ageDays" ? undefined : x));
  return { text: stable({ list: list.items, details }), cases: list.items.length };
};

let worker = await startWorker();
note(`worker 1 up at ${new Date().toISOString()}`);

await api("/demo/sessions", { method: "POST" });
await api("/demo/role", { method: "POST", body: { role: "manager" } });
const own = (await api("/cases?limit=3")).items;
const ready = own.find((c) => c.status === "Ready");
const review = own.find((c) => c.status === "Needs Review");
const detail = await api(`/cases/${ready.id}`);
await api(`/approvals/${detail.approval.id}/decision`, {
  method: "POST",
  key: "restart-proof-approve",
  body: { decision: "approve", caseVersion: ready.version },
});
const customers = (await api("/customers")).items;
const made = await api("/cases", {
  method: "POST",
  key: "restart-proof-create",
  body: { title: "Written before the restart", customerId: customers[0].id, caseType: "Billing" },
});
await api(`/cases/${review.id}/handoffs`, {
  method: "POST",
  body: { toQueue: "Seasonal Staffing", reason: "Before restart", expectedCaseVersion: 1 },
});
const before = await snapshot([ready.id, review.id, made.id]);
note(`wrote approval, new case and handoff; read ${before.cases} cases`);

await stopWorker(worker);
note("worker 1 stopped");
const restart = spawnSync("docker", ["restart", "opsbridge-postgres"], { encoding: "utf8" });
if (restart.status !== 0) throw new Error(`docker restart failed: ${restart.stderr}`);
for (let i = 0; i < 60; i++) {
  const ok = spawnSync("docker", [
    "exec",
    "opsbridge-postgres",
    "pg_isready",
    "-U",
    "opsbridge_admin",
  ]);
  if (ok.status === 0) break;
  await pause(500);
}
note("postgres container restarted");

worker = await startWorker();
note("worker 2 up");
const after = await snapshot([ready.id, review.id, made.id]);
const same = before.text === after.text;
note(`state identical after restart: ${same}`);
const replay = await api("/cases", {
  method: "POST",
  key: "restart-proof-create",
  body: { title: "Written before the restart", customerId: customers[0].id, caseType: "Billing" },
});
note(`idempotency key survived, same case returned: ${replay.id === made.id}`);
const next = await api(`/cases/${made.id}`, {
  method: "PATCH",
  body: { title: "Written after the restart", version: made.version },
});
note(`session cookie still works, write after restart at version ${next.version}`);
await stopWorker(worker);

const pass = same && replay.id === made.id && next.version === made.version + 1;
note(pass ? "RESTART PROOF PASSED" : "RESTART PROOF FAILED");
mkdirSync("docs/evidence/P2.5", { recursive: true });
writeFileSync("docs/evidence/P2.5/restart-proof.txt", `${lines.join("\n")}\n`);
process.exit(pass ? 0 : 1);
