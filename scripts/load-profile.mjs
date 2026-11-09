#!/usr/bin/env node
// P7.4: the documented small load profile (PRD 13.2). Runs the real Worker under wrangler dev
// against a fresh local database and drives it with a fixed number of simulated visitors, each
// from its own client address, so the per-address rate limit treats them as separate people.
// Reports latency per route (p50, p95, p99, max) and every non-2xx answer. Local hardware only:
// these numbers say nothing about Cloudflare, Hyperdrive or Neon.
// Each visitor stays under the Worker's 120-requests-a-minute limit per address, as a person
// clicking through the demo would; the limit itself is tested elsewhere.
//   node scripts/load-profile.mjs [visitors] [seconds]      default 20 visitors, 60 seconds
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { localUrl, migrate, relaxLimits, seed, setupLocal } from "./db.mjs";

const VISITORS = Number(process.argv[2] ?? 20);
const SECONDS = Number(process.argv[3] ?? 60);
const DB = "opsbridge_load_test";
const PORT = 8794;
const BASE = `http://localhost:${PORT}`;
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const conn = (role) => `postgres://${role}:local_dev_only@127.0.0.1:54330/${DB}?sslmode=disable`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const samples = new Map();
const errors = new Map();
const lines = [];
const say = (s) => {
  console.log(s);
  lines.push(s);
};

async function timed(route, fn) {
  const t = performance.now();
  let status = 0;
  try {
    const res = await fn();
    status = res.status;
    await res.arrayBuffer();
    return res;
  } finally {
    const ms = performance.now() - t;
    if (!samples.has(route)) samples.set(route, []);
    samples.get(route).push(ms);
    if (status < 200 || status >= 300) {
      const k = `${route} ${status}`;
      errors.set(k, (errors.get(k) ?? 0) + 1);
    }
  }
}

async function visitor(n, until) {
  const headers = { "cf-connecting-ip": `10.77.${Math.floor(n / 250)}.${n % 250}` };
  const write = { ...headers, origin: BASE, "content-type": "application/json" };
  await timed("GET / (landing)", () => fetch(`${BASE}/`, { headers }));
  const launch = await timed("POST /api/v1/demo/sessions", () =>
    fetch(`${BASE}/api/v1/demo/sessions`, { method: "POST", headers: write }),
  );
  const cookie = (launch.headers.get("set-cookie") ?? "").split(";")[0];
  const h = { ...headers, cookie };
  const w = { ...write, cookie };
  await fetch(`${BASE}/api/v1/demo/role`, {
    method: "POST",
    headers: w,
    body: '{"role":"manager"}',
  });
  const list = await (await fetch(`${BASE}/api/v1/cases?limit=20`, { headers: h })).json();
  const caseId = list.items[0].id;
  while (Date.now() < until) {
    await timed("GET /api/v1/cases", () => fetch(`${BASE}/api/v1/cases?limit=20`, { headers: h }));
    const detail = await timed("GET /api/v1/cases/{id}", () =>
      fetch(`${BASE}/api/v1/cases/${caseId}`, { headers: h }),
    );
    const version = (
      await detail
        .clone()
        .json()
        .catch(() => ({}))
    ).version;
    await timed("GET /api/v1/workspace/summary", () =>
      fetch(`${BASE}/api/v1/workspace/summary`, { headers: h }),
    );
    await timed("GET /api/v1/analytics/overview", () =>
      fetch(`${BASE}/api/v1/analytics/overview`, { headers: h }),
    );
    await timed("GET /api/v1/reports/operations", () =>
      fetch(`${BASE}/api/v1/reports/operations`, { headers: h }),
    );
    await timed("GET /api/v1/reconciliation", () =>
      fetch(`${BASE}/api/v1/reconciliation`, { headers: h }),
    );
    if (version) {
      await timed("PATCH /api/v1/cases/{id}", () =>
        fetch(`${BASE}/api/v1/cases/${caseId}`, {
          method: "PATCH",
          headers: w,
          body: JSON.stringify({ version, title: `Load profile ${Date.now()}` }),
        }),
      );
    }
    // A person reads between clicks: 7 requests every 4 to 5 s is under 120 a minute.
    await sleep(4000 + Math.random() * 1000);
  }
}

const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

await setupLocal(DB, { recreate: true });
await migrate(localUrl("opsbridge_migrator", DB));
await seed(localUrl("opsbridge_migrator", DB));
await relaxLimits(localUrl("opsbridge_migrator", DB));
spawnSync("npx", ["vite", "build", "--config", "frontend/vite.config.ts"], { cwd: repo });
const vars = join(repo, ".wrangler", "load.vars");
writeFileSync(vars, "IP_HASH_KEY=load-only-not-a-secret\n");
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
for (let t = Date.now(); ; ) {
  try {
    if ((await fetch(`${BASE}/health/ready`)).ok) break;
  } catch {}
  if (Date.now() - t > 60_000) throw new Error("worker did not start");
  await sleep(250);
}

const wrangler = execFileSync("npx", ["wrangler", "--version"], {
  cwd: repo,
  encoding: "utf8",
}).trim();
const model = (() => {
  try {
    return execFileSync("sysctl", ["-n", "hw.model"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();
say(`# Local load profile, ${new Date().toISOString()}`);
say(
  `machine ${model}, ${cpus().length} cores (${cpus()[0]?.model}), ${Math.round(totalmem() / 2 ** 30)} GB; node ${process.version}; wrangler ${wrangler}; Postgres 17 in Docker on the same machine`,
);
say(
  `profile: ${VISITORS} visitors at once for ${SECONDS} s, each from its own address; each launches a demo, then loops list, detail, summary, analytics overview, report, findings and one case edit, pausing 4 to 5 s between loops (under the 120-a-minute limit per address)`,
);
const until = Date.now() + SECONDS * 1000;
const t0 = Date.now();
await Promise.all(Array.from({ length: VISITORS }, (_, i) => visitor(i, until)));
const elapsed = (Date.now() - t0) / 1000;
child.kill("SIGTERM");

let total = 0;
let worstP95 = 0;
say("");
say("| Route | Requests | p50 ms | p95 ms | p99 ms | max ms |");
say("|---|---|---|---|---|---|");
for (const [route, xs] of [...samples].sort()) {
  xs.sort((a, b) => a - b);
  total += xs.length;
  const p95 = pct(xs, 95);
  if (route.startsWith("GET /api") || route.startsWith("PATCH") || route.startsWith("POST /api"))
    worstP95 = Math.max(worstP95, p95);
  say(
    `| ${route} | ${xs.length} | ${pct(xs, 50).toFixed(1)} | ${p95.toFixed(1)} | ${pct(xs, 99).toFixed(1)} | ${xs.at(-1).toFixed(1)} |`,
  );
}
say("");
say(`${total} requests in ${elapsed.toFixed(1)} s (${(total / elapsed).toFixed(1)} a second)`);
say(
  `non-2xx answers: ${errors.size ? [...errors].map(([k, v]) => `${k} x${v}`).join(", ") : "none"}`,
);
const ok = worstP95 < 500 && errors.size === 0;
say(
  `${ok ? "PASS" : "FAIL"} PRD 13.2 target, non-AI API p95 under 500 ms at this profile: worst route p95 ${worstP95.toFixed(1)} ms`,
);
writeFileSync(join(repo, "docs/evidence/P7.4/load-profile.txt"), `${lines.join("\n")}\n`);
process.exit(ok ? 0 : 1);
