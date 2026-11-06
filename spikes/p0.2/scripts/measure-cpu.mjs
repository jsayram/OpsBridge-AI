// Measures per-request CPU in workerd through the V8 inspector (Profiler domain).
// Active = all sampled time except (idle). This includes (program) and (garbage collector).
import WebSocket from "ws";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
const BASE = "http://localhost:8799";
const ws = new WebSocket("ws://localhost:9239/ws");
await new Promise((r) => ws.on("open", r));
let id = 0; const pending = new Map();
ws.on("message", (m) => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Profiler.enable"); await send("Profiler.setSamplingInterval", { interval: 100 });
const activeMs = (p) => {
  const fn = new Map(p.nodes.map((n) => [n.id, n.callFrame.functionName]));
  let t = 0, idle = 0;
  p.samples.forEach((s, i) => { const d = p.timeDeltas[i] ?? 0; (fn.get(s) === "(idle)" ? (idle += d) : (t += d)); });
  return { active: t / 1000, idle: idle / 1000 };
};
const stats = (a) => { const s = [...a].sort((x, y) => x - y); return { n: s.length, min: +s[0].toFixed(2), p50: +s[Math.floor(s.length / 2)].toFixed(2), p95: +s[Math.ceil(s.length * 0.95) - 1].toFixed(2), max: +s.at(-1).toFixed(2) }; };
const { ws: w, approval } = JSON.parse(execSync("node scripts/seed-proof.mjs 1").toString())[0];
const seeds = JSON.parse(execSync("node scripts/seed-proof.mjs 25").toString());
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
let seedIdx = 0;
const scenarios = {
  noop: () => fetch(`${BASE}/noop`),
  "read_cases (tx + set_config + select)": () => fetch(`${BASE}/cases/${w}`),
  "approve (full atomic command)": () => { const s = seeds[seedIdx++]; return fetch(`${BASE}/approve/${s.ws}/${s.approval}`, { method: "POST", body: JSON.stringify({ actor: "proof", version: 1 }) }); },
  "rs256_sign (import + sign)": () => fetch(`${BASE}/sign`, { method: "POST", body: pkcs8 }),
  "pdf_1p": () => fetch(`${BASE}/pdf`, { method: "POST", body: readFileSync("fixtures/synthetic-1p.pdf") }),
  "pdf_5p": () => fetch(`${BASE}/pdf`, { method: "POST", body: readFileSync("fixtures/synthetic-5p.pdf") }),
  "pdf_20p": () => fetch(`${BASE}/pdf`, { method: "POST", body: readFileSync("fixtures/synthetic-20p.pdf") }),
};
const results = {};
for (const [name, run] of Object.entries(scenarios)) {
  const n = name.startsWith("approve") ? 20 : 25;
  const first = [], warm = [], wall = []; 
  for (let i = 0; i < n + 2; i++) {
    await send("Profiler.start");
    const t0 = performance.now(); const r = await run(); const body = await r.text(); const t = performance.now() - t0;
    await new Promise((x) => setTimeout(x, 15));
    const { result } = await send("Profiler.stop");
    const a = activeMs(result.profile);
    if (r.status !== 200) { console.error(name, r.status, body.slice(0, 200)); }
    (i < 2 ? first : warm).push(a.active); if (i >= 2) wall.push(t);
  }
  results[name] = { firstTwoActiveMs: first.map((x) => +x.toFixed(2)), warmActiveMs: stats(warm), warmWallMs: stats(wall) };
  console.log(name, JSON.stringify(results[name]));
}
writeFileSync(process.argv[2], JSON.stringify({ takenAt: new Date().toISOString(), method: "V8 Profiler via workerd inspector, 100us sampling, active = non-idle samples", host: execSync("sysctl -n machdep.cpu.brand_string").toString().trim(), workerd: execSync("node_modules/.bin/workerd --version").toString().trim(), results }, null, 2));
ws.close();
