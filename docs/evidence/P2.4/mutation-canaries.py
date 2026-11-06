#!/usr/bin/env python3
# Breaks one safeguard at a time, runs the nearest tests and expects them to fail. Restores the
# file after each run. Run from the repository root on a clean tree.
import subprocess, sys

CMDS = "backend/src/repo/caseCommands.ts"
RECS = "backend/src/repo/records.ts"
MIG = "backend/migrations/0003_core_records.sql"
SPLIT = """  await ctx.db.query("COMMIT");
  await ctx.db.query("BEGIN");
  await ctx.db.query("SELECT set_config('app.workspace_id', $1, true)", [ctx.workspaceId]);
"""

M = [
    ("M1 approval skips the outbox insert", CMDS,
     'await emitEvent(ctx, "approval.completed", `approval:${approvalId}`, ref, {\n    caseRef: ref,\n    decision: status,\n  });',
     "void emitEvent;", "approvals"),
    ("M2 approval skips the audit row", CMDS,
     'await writeAudit(ctx, "approval.completed", caseId, {', 'void ({', "approvals"),
    ("M3 decision commits before the state change (split transaction)", CMDS,
     '  const updated = await ctx.db.query(\n    `UPDATE app.cases SET status = $3, version = version + 1\n      WHERE workspace_id = $1 AND id = $2 AND version = $4 RETURNING version`,\n    [ctx.workspaceId, caseId, to, input.caseVersion],',
     SPLIT + '  const updated = await ctx.db.query(\n    `UPDATE app.cases SET status = $3, version = version + 1\n      WHERE workspace_id = $1 AND id = $2 AND version = $4 RETURNING version`,\n    [ctx.workspaceId, caseId, to, input.caseVersion],', "approvals"),
    ("M4 approval drops both version checks", CMDS,
     'if (before.version !== input.caseVersion) throw stale();\n  const from = before.status as CaseStatus;\n  const to: CaseStatus = input.decision',
     'const from = before.status as CaseStatus;\n  input.caseVersion = before.version as number;\n  const to: CaseStatus = input.decision', "approvals"),
    ("M5 approval drops the already-decided check", CMDS,
     'if (approval?.status !== "pending") {', 'if (false) {', "approvals"),
    ("M6 idempotency ignores a changed body", RECS,
     'if (rows[0]?.hash !== requestHash) {', 'if (false) {', "cases-api"),
    ("M8 checklist gate removed", CMDS,
     'if (checklistBlocks(to, items)) {', 'if (false && checklistBlocks(to, items)) {', "workflow"),
    ("M9 handoff accepts any assignee", CMDS,
     'WHERE workspace_id = $1 AND id = $2 AND active AND can_receive_cases`', 'WHERE workspace_id = $1 AND id = $2`', "workflow"),
    ("M10 commands stop taking the case lock", "backend/src/repo/cases.ts",
     '"SELECT id FROM app.cases WHERE workspace_id = $1 AND id = $2 FOR UPDATE"', '"SELECT id FROM app.cases WHERE workspace_id = $1 AND id = $2"', "workflow"),
    ("M11 purge takes the workspace lock first again", MIG,
     "  PERFORM 1 FROM app.demo_sessions WHERE workspace_id = ws ORDER BY id FOR UPDATE;\n  SELECT mode, expires_at INTO w FROM app.workspaces WHERE id = ws FOR UPDATE;\n  IF NOT FOUND OR w.mode <> 'demo' OR w.expires_at >= now() - interval '60 seconds' THEN\n    RAISE EXCEPTION 'refusing to purge workspace %', ws USING ERRCODE = 'P0002';\n  END IF;\n  DELETE FROM app.audit_events WHERE workspace_id = ws; GET DIAGNOSTICS a = ROW_COUNT;\n  DELETE FROM app.idempotency_keys",
     "  SELECT mode, expires_at INTO w FROM app.workspaces WHERE id = ws FOR UPDATE;\n  IF NOT FOUND OR w.mode <> 'demo' OR w.expires_at >= now() - interval '60 seconds' THEN\n    RAISE EXCEPTION 'refusing to purge workspace %', ws USING ERRCODE = 'P0002';\n  END IF;\n  DELETE FROM app.audit_events WHERE workspace_id = ws; GET DIAGNOSTICS a = ROW_COUNT;\n  DELETE FROM app.idempotency_keys", "expiry-race"),
    ("M12 runtime role can rewrite the outbox", MIG,
     "GRANT SELECT, INSERT ON app.consultant_handoffs, app.outbox TO opsbridge_app;",
     "GRANT SELECT, INSERT, UPDATE ON app.consultant_handoffs, app.outbox TO opsbridge_app;", "schema"),
]

survived = 0
for name, path, old, new, target in M:
    src = open(path).read()
    if old not in src:
        print(f"SETUP ERROR {name}: pattern not found")
        sys.exit(2)
    open(path, "w").write(src.replace(old, new, 1))
    try:
        r = subprocess.run(
            ["npx", "vitest", "run", "--config", "vitest.integration.config.ts", f"tests/integration/{target}"],
            capture_output=True, text=True, timeout=280)
        out = r.stdout + r.stderr
        tests = [l.strip() for l in out.splitlines() if " Tests " in l or l.strip().startswith("Tests ")]
        fails = [l.strip()[:120] for l in out.splitlines() if l.strip().startswith("FAIL")]
        caught = r.returncode != 0
        print(f"{'CAUGHT  ' if caught else 'SURVIVED'} {name}: {tests[-1] if tests else '?'}")
        for f in fails[:3]:
            print(f"    {f}")
        survived += 0 if caught else 1
    finally:
        open(path, "w").write(src)
    sys.stdout.flush()
print(f"survivors: {survived}")
