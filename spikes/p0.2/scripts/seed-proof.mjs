// Inserts a fresh proof workspace with one case and one pending approval; prints ids.
import pg from "pg";
const c = new pg.Client({ connectionString: "postgres://opsbridge_admin:local_dev_only@127.0.0.1:54330/opsbridge" });
await c.connect();
const n = Number(process.argv[2] ?? 1), mode = process.argv[3] ?? "owner";
const out = [];
for (let i = 0; i < n; i++) {
  const w = (await c.query("INSERT INTO app.workspaces(name,mode,expires_at) VALUES ($1,$2,$3) RETURNING id", [`proof-${i}`, mode, mode === "demo" ? new Date(Date.now() + 3600e3) : null])).rows[0].id;
  const k = (await c.query("INSERT INTO app.cases(workspace_id,title) VALUES ($1,'Fictional case') RETURNING id", [w])).rows[0].id;
  const a = (await c.query("INSERT INTO app.approvals(workspace_id,case_id) VALUES ($1,$2) RETURNING id", [w, k])).rows[0].id;
  out.push({ ws: w, caseId: k, approval: a });
}
console.log(JSON.stringify(out)); await c.end();
