// ADR-000 proof Worker. Not application code.
import { Hono } from "hono";
import { Client } from "pg";
import { extractText, getDocumentProxy } from "unpdf";

type Env = { HYPERDRIVE: Hyperdrive; HYPERDRIVE_CLEANUP: Hyperdrive };
const app = new Hono<{ Bindings: Env }>();
const pgClient = (env: Env) => new Client({ connectionString: env.HYPERDRIVE.connectionString });

app.get("/noop", (c) => c.json({ ok: true }));

// Same shape as a typical read endpoint: validate, one scoped query, map, respond.
app.get("/cases/:ws", async (c) => {
  const client = pgClient(c.env);
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [c.req.param("ws")]);
    const r = await client.query("SELECT id,title,status,version FROM app.cases WHERE workspace_id=$1 ORDER BY id LIMIT 25", [c.req.param("ws")]);
    await client.query("COMMIT");
    return c.json({ items: r.rows.map((x) => ({ ...x, label: `${x.title} (${x.status})` })) });
  } finally { await client.end(); }
});

// Connect + auth + close only: isolates driver and SCRAM cost from query cost.
app.get("/connect", async (c) => {
  const client = pgClient(c.env);
  await client.connect();
  await client.end();
  return c.json({ ok: true });
});

// One statement, no explicit transaction: fewer round trips than BEGIN/SET/SELECT/COMMIT.
app.get("/cases1/:ws", async (c) => {
  const client = pgClient(c.env);
  await client.connect();
  try {
    const r = await client.query("WITH s AS (SELECT set_config('app.workspace_id',$1,true)) SELECT id,title,status,version FROM app.cases, s WHERE workspace_id=$1::uuid ORDER BY id LIMIT 25", [c.req.param("ws")]);
    return c.json({ items: r.rows });
  } finally { await client.end(); }
});

app.post("/pdf", async (c) => {
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return c.json({ totalPages, chars: text.length, head: text.slice(0, 80) });
});

// Approval: one atomic command. Row version check, state change, audit, outbox.
app.post("/approve/:ws/:approval", async (c) => {
  const { ws, approval } = c.req.param();
  const { actor, version } = await c.req.json<{ actor: string; version: number }>();
  const client = pgClient(c.env);
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [ws]);
    const a = await client.query(
      "UPDATE app.approvals SET status='approved', actor=$3, decided_at=now() WHERE workspace_id=$1 AND id=$2 AND status='pending' RETURNING case_id",
      [ws, approval, actor]);
    if (a.rowCount === 0) { await client.query("ROLLBACK"); return c.json({ code: "conflict", reason: "already_decided" }, 409); }
    const u = await client.query(
      "UPDATE app.cases SET status='approved', version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$3 AND status='ready' RETURNING version",
      [ws, a.rows[0].case_id, version]);
    if (u.rowCount === 0) { await client.query("ROLLBACK"); return c.json({ code: "conflict", reason: "stale_version" }, 409); }
    await client.query("INSERT INTO app.audit_events(workspace_id,actor,action,target) VALUES ($1,$2,'approval.decided',$3)", [ws, actor, approval]);
    await client.query("INSERT INTO app.outbox(workspace_id,event_type,idempotency_key) VALUES ($1,'approval.completed',$2)", [ws, `approval:${approval}`]);
    if (c.req.header("x-fail-before-commit")) throw new Error("injected failure");
    await client.query("COMMIT");
    return c.json({ ok: true, version: u.rows[0].version });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return c.json({ code: "failed", message: String(e) }, 500);
  } finally { await client.end(); }
});

// RS256 signing cost: the Google service-account JWT must be signed in the Worker.
app.post("/sign", async (c) => {
  const pkcs8 = Uint8Array.from(atob((await c.req.text()).trim()), (x) => x.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode("header.claims"));
  return c.json({ bytes: sig.byteLength });
});

// Dispatcher tick against a simulated sheet in Postgres. fail=crash_after_write
// models a Worker dying after the sink accepted the row but before the ack.
async function tick(env: Env, fail?: string) {
  const client = pgClient(env);
  await client.connect();
  const out = { claimed: 0, written: 0, skippedDuplicate: 0, crashed: 0 };
  try {
    const { rows } = await client.query("SELECT * FROM app.claim_due_outbox(10, 130)");
    out.claimed = rows.length;
    for (const ev of rows) {
      const seen = await client.query("SELECT 1 FROM sim.sheet_rows WHERE event_id=$1", [ev.id]);
      if (seen.rowCount === 0) {
        await client.query("INSERT INTO sim.sheet_rows(event_id, row_text) VALUES ($1,$2)", [ev.id, ev.event_type]);
        out.written++;
      } else out.skippedDuplicate++;
      if (fail === "crash_after_write") { out.crashed++; continue; }
      await client.query("SELECT app.finish_outbox($1,$2,'accepted')", [ev.workspace_id, ev.id]);
    }
  } finally { await client.end(); }
  return out;
}
app.post("/tick", async (c) => c.json(await tick(c.env, c.req.query("fail"))));

export default {
  fetch: app.fetch,
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(tick(env).then((r) => console.log("sweep", JSON.stringify(r)))); },
};
