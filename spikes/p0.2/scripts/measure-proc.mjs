// Second, independent method: OS CPU time of the workerd process that runs the Worker,
// over N requests, minus nothing. Includes runtime overhead, so it is an upper bound on
// what a Worker is charged. The sampling profiler is not attached during this run.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const BASE = "http://localhost:8799";
const pid = execSync("pgrep -f -- 'workerd serve.*inspector-addr'").toString().trim().split("\n")[0];
const cpu = () => { const t = execSync(`ps -o cputime= -p ${pid}`).toString().trim().split(":").map(Number); return (t.length === 3 ? t[0]*3600e3 + t[1]*60e3 + t[2]*1e3 : t[0]*60e3 + t[1]*1e3); };
const { ws: w } = JSON.parse(execSync("node scripts/seed-proof.mjs 1").toString())[0];
const N = 300;
const seeds = JSON.parse(execSync(`node scripts/seed-proof.mjs ${N}`).toString());
let s = 0;
const pdf = (f) => { const b = readFileSync(f); return () => fetch(`${BASE}/pdf`, { method: "POST", body: b }); };
const scenarios = {
  noop: () => fetch(`${BASE}/noop`),
  connect_only: () => fetch(`${BASE}/connect`),
  read_single_statement: () => fetch(`${BASE}/cases1/${w}`),
  read_explicit_tx: () => fetch(`${BASE}/cases/${w}`),
  approve_full_command: () => { const x = seeds[s++]; return fetch(`${BASE}/approve/${x.ws}/${x.approval}`, { method: "POST", body: JSON.stringify({ actor: "proof", version: 1 }) }); },
  pdf_1p: pdf("fixtures/synthetic-1p.pdf"), pdf_5p: pdf("fixtures/synthetic-5p.pdf"), pdf_20p: pdf("fixtures/synthetic-20p.pdf"),
};
const out = {};
for (const [k, run] of Object.entries(scenarios)) {
  for (let i = 0; i < 5; i++) await (await run()).text().catch(()=>{});
  if (k === "approve_full_command") s = 5;
  const n = k.startsWith("approve") ? N - 5 : N;
  const t0 = cpu(), w0 = performance.now(); let bad = 0;
  for (let i = 0; i < n; i++) { const r = await run(); await r.text(); if (r.status !== 200) bad++; }
  const ms = cpu() - t0; const wall = performance.now() - w0;
  out[k] = { n, processCpuMsPerRequest: +(ms / n).toFixed(2), wallMsPerRequest: +(wall / n).toFixed(2), non200: bad };
  console.log(k, JSON.stringify(out[k]));
}
writeFileSync(process.argv[2], JSON.stringify({ takenAt: new Date().toISOString(), method: "ps cputime delta of the user workerd process across N sequential requests; profiler detached", host: execSync("sysctl -n machdep.cpu.brand_string").toString().trim(), results: out }, null, 2));
