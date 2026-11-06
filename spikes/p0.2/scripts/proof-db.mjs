// ADR-000 proofs 2, 3, 4 and the seed-weight check, against Docker Postgres through
// the Worker under wrangler dev (proof 2 and 4) and direct role connections (proof 3).
// Hyperdrive itself is NOT exercised: local mode connects straight to Postgres.
import pg from "pg";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const BASE = "http://localhost:8799";
const url = (u) => `postgres://${u}:local_dev_only@127.0.0.1:54330/opsbridge`;
const conn = async (u) => { const c = new pg.Client({ connectionString: url(u) }); await c.connect(); return c; };
const admin = await conn("opsbridge_admin");
const results = []; let failed = 0;
const check = (id, ok, detail = "") => { results.push({ id, pass: !!ok, detail }); if (!ok) failed++; console.log(ok ? "PASS" : "FAIL", id, detail); };
const denied = async (id, fn, match) => { try { const r = await fn(); check(id, false, `expected error, got rowCount=${r?.rowCount}`); } catch (e) { check(id, match.test(e.message), e.message); } };
const seed = (n, mode = "owner") => JSON.parse(execSync(`node scripts/seed-proof.mjs ${n} ${mode}`).toString());
const count = async (t, ws) => +(await admin.query(`SELECT count(*) FROM app.${t} WHERE workspace_id=$1`, [ws])).rows[0].count;
const approve = (s, h = {}, version = 1, approval = s.approval) => fetch(`${BASE}/approve/${s.ws}/${approval}`, { method: "POST", headers: h, body: JSON.stringify({ actor: "proof", version }) });

// PROOF 2: approval transaction under concurrency
const rounds = seed(30);
let oneWinner = 0, exactEffects = 0;
for (const s of rounds) {
  const rs = await Promise.all(Array.from({ length: 20 }, () => approve(s)));
  const ok = rs.filter((r) => r.status === 200).length, conflict = rs.filter((r) => r.status === 409).length;
  if (ok === 1 && conflict === 19) oneWinner++;
  const v = (await admin.query("SELECT version,status FROM app.cases WHERE workspace_id=$1", [s.ws])).rows[0];
  if ((await count("audit_events", s.ws)) === 1 && (await count("outbox", s.ws)) === 1 && v.version === 2 && v.status === "approved") exactEffects++;
}
check("P2.a 20 concurrent approvals, 30 rounds: 1 winner, 19 typed conflicts", oneWinner === 30, `${oneWinner}/30 rounds`);
check("P2.b exactly one state change, audit row and outbox row per round", exactEffects === 30, `${exactEffects}/30 rounds`);
const [f] = seed(1);
const rf = await approve(f, { "x-fail-before-commit": "1" });
const af = (await admin.query("SELECT status FROM app.approvals WHERE workspace_id=$1", [f.ws])).rows[0].status;
const cf = (await admin.query("SELECT status,version FROM app.cases WHERE workspace_id=$1", [f.ws])).rows[0];
check("P2.c injected failure before COMMIT leaves nothing behind", rf.status === 500 && af === "pending" && cf.status === "ready" && cf.version === 1 && (await count("audit_events", f.ws)) === 0 && (await count("outbox", f.ws)) === 0);
const [st] = seed(1);
const rs = await approve(st, {}, 99);
check("P2.d stale case version rejected and rolled back", rs.status === 409 && (await count("audit_events", st.ws)) === 0 && (await admin.query("SELECT status FROM app.approvals WHERE workspace_id=$1", [st.ws])).rows[0].status === "pending");
const [dup] = seed(1);
await admin.query("BEGIN"); await admin.query("INSERT INTO app.outbox(workspace_id,event_type,idempotency_key) VALUES ($1,'x','k1')", [dup.ws]);
await denied("P2.e duplicate idempotency key rejected by unique constraint", () => admin.query("INSERT INTO app.outbox(workspace_id,event_type,idempotency_key) VALUES ($1,'x','k1')", [dup.ws]), /duplicate key/);
await admin.query("ROLLBACK");

// PROOF 3: isolation and least privilege
const [A, B] = seed(2, "demo");
const appc = await conn("opsbridge_app");
const inWs = async (c, ws, fn) => { await c.query("BEGIN"); await c.query("SELECT set_config('app.workspace_id',$1,true)", [ws]); try { const r = await fn(); await c.query("COMMIT"); return r; } catch (e) { await c.query("ROLLBACK"); throw e; } };
check("P3.a no workspace set returns no rows", (await appc.query("SELECT * FROM app.cases")).rowCount === 0);
check("P3.b A cannot read B by id", (await inWs(appc, A.ws, () => appc.query("SELECT * FROM app.cases WHERE id=$1", [B.caseId]))).rowCount === 0);
check("P3.c A cannot update B", (await inWs(appc, A.ws, () => appc.query("UPDATE app.cases SET title='x' WHERE id=$1", [B.caseId]))).rowCount === 0);
await denied("P3.d A cannot insert into B", () => inWs(appc, A.ws, () => appc.query("INSERT INTO app.cases(workspace_id,title) VALUES ($1,'x')", [B.ws])), /row-level security/);
check("P3.e set_config does not survive COMMIT on a reused connection", (await appc.query("SELECT app.current_workspace() w")).rows[0].w === null);
await denied("P3.f app role cannot DELETE cases", () => inWs(appc, A.ws, () => appc.query("DELETE FROM app.cases")), /permission denied/);
await denied("P3.g app role cannot DELETE audit_events", () => inWs(appc, A.ws, () => appc.query("DELETE FROM app.audit_events")), /permission denied/);
await denied("P3.h app role cannot UPDATE audit_events", () => inWs(appc, A.ws, () => appc.query("UPDATE app.audit_events SET actor='x'")), /permission denied/);
await denied("P3.i app role cannot TRUNCATE audit_events", () => appc.query("TRUNCATE app.audit_events"), /permission denied/);
await denied("P3.j app role cannot run the purge", () => appc.query("SELECT app.purge_demo_workspace($1)", [A.ws]), /permission denied/);
const tr = await approve(A); await tr.text();
await denied("P3.k even the admin owner cannot UPDATE an audit row", () => admin.query("UPDATE app.audit_events SET actor='x' WHERE workspace_id=$1", [A.ws]), /append-only/);
await denied("P3.l even the admin owner cannot DELETE an audit row", () => admin.query("DELETE FROM app.audit_events WHERE workspace_id=$1", [A.ws]), /append-only/);
await denied("P3.m even the admin owner cannot TRUNCATE audit_events", () => admin.query("TRUNCATE app.audit_events"), /append-only/);
const clean = await conn("opsbridge_cleanup");
await denied("P3.n cleanup cannot UPDATE audit rows", () => clean.query("UPDATE app.audit_events SET actor='x'"), /permission denied/);
await denied("P3.o cleanup cannot INSERT business rows", () => clean.query("INSERT INTO app.cases(workspace_id,title) VALUES ($1,'x')", [A.ws]), /permission denied/);
await denied("P3.p cleanup cannot purge an unexpired demo workspace", () => clean.query("SELECT app.purge_demo_workspace($1)", [A.ws]), /refusing to purge/);
await denied("P3.q cleanup has no direct DELETE on audit rows", () => clean.query("DELETE FROM app.audit_events WHERE workspace_id=$1", [A.ws]), /permission denied/);
await denied("P3.q2 cleanup has no direct DELETE on business rows", () => clean.query("DELETE FROM app.cases WHERE workspace_id=$1", [A.ws]), /permission denied/);
const [O] = seed(1, "owner"); await (await approve(O)).text();
await denied("P3.r cleanup cannot purge an owner workspace", () => clean.query("SELECT app.purge_demo_workspace($1)", [O.ws]), /refusing to purge/);
await denied("P3.s cleanup cannot delete owner cases directly", () => clean.query("DELETE FROM app.cases WHERE workspace_id=$1", [O.ws]), /permission denied/);
await denied("P3.s2 app cannot flip a workspace mode or expiry directly", () => inWs(appc, O.ws, () => appc.query("UPDATE app.workspaces SET mode='demo', expires_at=now() WHERE id=$1", [O.ws])), /permission denied/);
await denied("P3.s3 app cannot insert a workspace directly", () => appc.query("INSERT INTO app.workspaces(name,mode) VALUES ('x','owner')"), /permission denied/);
check("P3.s4 A cannot see B or owner in workspaces", (await inWs(appc, A.ws, () => appc.query("SELECT id FROM app.workspaces WHERE id = ANY($1)", [[B.ws, O.ws]]))).rowCount === 0);
check("P3.s5 expire function refuses an owner workspace", (await inWs(appc, O.ws, () => appc.query("SELECT app.expire_demo_workspace() r"))).rows[0].r === false && (await admin.query("SELECT expires_at FROM app.workspaces WHERE id=$1", [O.ws])).rows[0].expires_at === null);
check("P3.s6 expire function works on own demo workspace only", (await inWs(appc, B.ws, () => appc.query("SELECT app.expire_demo_workspace() r"))).rows[0].r === true);
await admin.query("UPDATE app.workspaces SET expires_at = now() + interval '1 hour' WHERE id=$1", [B.ws]);
await denied("P3.s7 launch refused at capacity, expired workspaces counted", () => appc.query("SELECT app.create_demo_workspace(7200, 1)"), /demo_capacity/);
const fresh = (await appc.query("SELECT app.create_demo_workspace(7200, 100000) id")).rows[0].id;
check("P3.s8 launch works under capacity", !!fresh);
await admin.query("UPDATE app.workspaces SET expires_at = now() - interval '1 minute' WHERE id=$1", [A.ws]);
const listed = (await clean.query("SELECT * FROM app.expired_demo_workspaces(5)")).rows.map((r) => r.expired_demo_workspaces);
check("P3.t0 cleanup lists expired demo workspaces only", listed.includes(A.ws) && !listed.includes(O.ws) && !listed.includes(B.ws));
const purged = (await clean.query("SELECT app.purge_demo_workspace($1) n", [A.ws])).rows[0].n;
const left = (await count("audit_events", A.ws)) + (await count("cases", A.ws)) + (await count("approvals", A.ws)) + (await count("outbox", A.ws));
const rl = (await admin.query("SELECT audit_rows,business_rows FROM app.retention_log WHERE workspace_id=$1", [A.ws])).rows[0];
check("P3.t expired demo purge removes every row and writes a retention record", left === 0 && purged > 0 && rl?.audit_rows === 1, `purged=${purged} retention=${JSON.stringify(rl)}`);
check("P3.u purge of A left B and owner rows intact", (await count("cases", B.ws)) === 1 && (await count("audit_events", O.ws)) === 1);

// PROOF 4: outbox dispatch, failure and replay (sheet simulated in Postgres)
await admin.query("UPDATE app.outbox SET dispatch_state='accepted'");
await admin.query("TRUNCATE sim.sheet_rows");
const evs = seed(5);
for (const s of evs) await (await approve(s)).text();
const tick = async (q = "") => (await fetch(`${BASE}/tick${q}`, { method: "POST" })).json();
const t1 = await tick("?fail=crash_after_write");
const sheet = async () => +(await admin.query("SELECT count(*) FROM sim.sheet_rows")).rows[0].count;
check("P4.a crash after sink write, before ack: rows written, events stay processing", t1.written === 5 && (await sheet()) === 5 && +(await admin.query("SELECT count(*) FROM app.outbox WHERE dispatch_state='processing'")).rows[0].count === 5, JSON.stringify(t1));
const t2 = await tick();
check("P4.b live lease blocks a second claim", t2.claimed === 0, JSON.stringify(t2));
await admin.query("UPDATE app.outbox SET lease_expires_at = now() - interval '1 second' WHERE dispatch_state='processing'");
const t3 = await tick();
check("P4.c replay after lease expiry: check-before-append skips all, sheet still 5 rows", t3.claimed === 5 && t3.skippedDuplicate === 5 && t3.written === 0 && (await sheet()) === 5, JSON.stringify(t3));
const many = seed(20); for (const s of many) await (await approve(s)).text();
const ticks = await Promise.all(Array.from({ length: 8 }, () => tick()));
const claimed = ticks.reduce((a, t) => a + t.claimed, 0);
const rest = await tick(); 
check("P4.d 8 parallel dispatchers never double-claim (SKIP LOCKED)", claimed + rest.claimed === 20 && (await sheet()) === 25, `parallel claimed=${claimed}, follow-up=${rest.claimed}, sheet=${await sheet()}`);
const lost = seed(3); for (const s of lost) await (await approve(s)).text();
const sw = await fetch(`${BASE}/__scheduled?cron=*/30+*+*+*+*`);
await new Promise((r) => setTimeout(r, 800));
const open = +(await admin.query("SELECT count(*) FROM app.outbox WHERE dispatch_state IN ('pending','processing','retry_scheduled')")).rows[0].count;
check("P4.e cron sweep picks up committed events that were never dispatched after commit", sw.status === 200 && open === 0 && (await sheet()) === 28, `status=${sw.status} open=${open} sheet=${await sheet()}`);

const tw = (await admin.query("INSERT INTO app.workspaces(name,mode) VALUES ('template','template') RETURNING id")).rows[0].id;
await admin.query("INSERT INTO app.outbox(workspace_id,event_type,idempotency_key) VALUES ($1,'approval.completed','tpl-1')", [tw]);
const t6 = await tick();
check("P4.f dispatcher never claims template events", t6.claimed === 0 && (await admin.query("SELECT dispatch_state FROM app.outbox WHERE workspace_id=$1", [tw])).rows[0].dispatch_state === "pending", JSON.stringify(t6));
const [dl] = seed(1); await (await approve(dl)).text();
await admin.query("UPDATE app.outbox SET dispatch_state='processing', attempts=6, lease_expires_at=now()-interval '1 second' WHERE workspace_id=$1", [dl.ws]);
const t7 = await tick();
check("P4.g event whose Worker keeps dying stops at the attempt cap", t7.claimed === 0 && (await admin.query("SELECT dispatch_state FROM app.outbox WHERE workspace_id=$1", [dl.ws])).rows[0].dispatch_state === "dead_letter");

// Seed weight: full Section 16 copy per session versus a small scenario pack
await admin.query("CREATE TEMP TABLE w AS SELECT 1");
const time = async (rows) => { const ws = (await admin.query("INSERT INTO app.workspaces(name,mode,expires_at) VALUES ('s','demo',now()+interval '1 hour') RETURNING id")).rows[0].id; const t = performance.now(); await admin.query("INSERT INTO app.cases(workspace_id,title) SELECT $1, 'Fictional case number ' || g FROM generate_series(1,$2) g", [ws, rows]); return performance.now() - t; };
const seedTiming = { rows35Ms: +(await time(35)).toFixed(2), rows1500Ms: +(await time(1500)).toFixed(2) };
console.log("seed", seedTiming);
writeFileSync(process.argv[2], JSON.stringify({ takenAt: new Date().toISOString(), environment: "Docker postgres:17-alpine, wrangler dev local mode, Hyperdrive localConnectionString (Hyperdrive not in path)", passed: results.length - failed, failed, results, seedTiming }, null, 2));
await appc.end(); await clean.end(); await admin.end();
console.log(`passed ${results.length - failed}, failed ${failed}`); process.exit(failed ? 1 : 0);
