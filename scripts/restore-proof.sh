#!/usr/bin/env bash
# pg_dump to clean restore proof on local Docker Postgres. Dumps the given database,
# restores into a throwaway database and proves data, guards, RLS, grants and functions
# survived on the restored copy, not on the source.
# Usage: scripts/restore-proof.sh [source-db]. Exits non-zero on any mismatch.
set -euo pipefail
src="${1:-opsbridge}"
dst="${src}_restore"
ctr=opsbridge-postgres
q() { docker exec -i "$ctr" psql -U opsbridge_admin -d "$1" -v ON_ERROR_STOP=1 -Atq -c "$2"; }
q_app() { docker exec -i -e PGPASSWORD=local_dev_only "$ctr" psql -h 127.0.0.1 -U "$1" -d "$dst" -v ON_ERROR_STOP=1 -Atq -c "$2"; }
fail=0
check() { if [[ "$2" == "$3" ]]; then echo "PASS $1"; else echo "FAIL $1: got [$2] want [$3]"; fail=1; fi; }
denied() { local out; if out=$("${@:3}" 2>&1); then echo "FAIL $1: statement succeeded"; fail=1
  elif grep -q "$2" <<<"$out"; then echo "PASS $1"; else echo "FAIL $1: $out"; fail=1; fi; }

echo "# Local backup and clean restore, $(date -u +%FT%TZ), source $src"
docker exec "$ctr" pg_dump -U opsbridge_admin -d "$src" -Fc -f /tmp/restore-proof.dump
echo "dump bytes: $(docker exec "$ctr" stat -c %s /tmp/restore-proof.dump)"
q postgres "DROP DATABASE IF EXISTS $dst" 2>/dev/null
q postgres "CREATE DATABASE $dst"
docker exec "$ctr" pg_restore -U opsbridge_admin -d "$dst" --exit-on-error /tmp/restore-proof.dump
docker exec "$ctr" rm -f /tmp/restore-proof.dump

tables=$(q "$src" "SELECT string_agg(tablename, ' ' ORDER BY tablename) FROM pg_tables WHERE schemaname='app'")
for t in $tables; do
  # Row data bypasses RLS because the admin role owns the tables.
  sql="SELECT count(*), coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '-') FROM app.$t x"
  check "data $t $(q "$src" "SELECT count(*) FROM app.$t") rows" "$(q "$dst" "$sql")" "$(q "$src" "$sql")"
done
meta_rls="SELECT string_agg(relname||':'||relrowsecurity, ',' ORDER BY relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r'"
check "RLS flags" "$(q "$dst" "$meta_rls")" "$(q "$src" "$meta_rls")"
meta_pol="SELECT string_agg(tablename||'.'||policyname, ',' ORDER BY tablename, policyname) FROM pg_policies WHERE schemaname='app'"
check "policies" "$(q "$dst" "$meta_pol")" "$(q "$src" "$meta_pol")"
meta_gr="SELECT string_agg(grantee||':'||table_name||':'||privilege_type, ',' ORDER BY grantee, table_name, privilege_type) FROM information_schema.role_table_grants WHERE table_schema='app' AND grantee LIKE 'opsbridge%' AND grantee<>'opsbridge_admin'"
check "table grants" "$(q "$dst" "$meta_gr")" "$(q "$src" "$meta_gr")"
meta_fn="SELECT string_agg(routine_name||':'||grantee, ',' ORDER BY routine_name, grantee) FROM information_schema.routine_privileges WHERE routine_schema='app' AND grantee LIKE 'opsbridge%' AND grantee<>'opsbridge_admin'"
check "function grants" "$(q "$dst" "$meta_fn")" "$(q "$src" "$meta_fn")"
meta_trg="SELECT string_agg(tgrelid::regclass||'.'||tgname, ',' ORDER BY tgrelid::regclass::text, tgname) FROM pg_trigger WHERE NOT tgisinternal"
check "triggers" "$(q "$dst" "$meta_trg")" "$(q "$src" "$meta_trg")"
check "cleanup role has no table rights" "$(q "$dst" "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='opsbridge_cleanup' AND table_schema='app'")" "0"

# A row trigger can't fire on an empty table, so an empty table would pass vacuously.
if [[ "$(q "$dst" "SELECT count(*) FROM app.audit_events")" == "0" ]]; then
  q "$dst" "INSERT INTO app.audit_events (workspace_id, actor_type, actor_id, action, target)
            SELECT id, 'system', 'restore-proof', 'proof', 'proof' FROM app.workspaces LIMIT 1"
fi
denied "guard on restored copy: admin UPDATE audit row" "append-only" q "$dst" "UPDATE app.audit_events SET action='x'"
denied "guard on restored copy: admin DELETE audit row" "append-only" q "$dst" "DELETE FROM app.audit_events"
denied "guard on restored copy: admin TRUNCATE audit" "append-only" q "$dst" "TRUNCATE app.audit_events"
denied "restored copy: app role cannot DELETE audit" "permission denied" q_app opsbridge_app "DELETE FROM app.audit_events"
denied "restored copy: app role cannot write workspaces" "permission denied" q_app opsbridge_app "INSERT INTO app.workspaces(name,mode) VALUES ('x','owner')"
denied "restored copy: cleanup cannot read cases" "permission denied" q_app opsbridge_cleanup "SELECT 1 FROM app.cases"
denied "restored copy: app role cannot change the outbox" "permission denied" q_app opsbridge_app "UPDATE app.outbox SET dispatch_state='accepted'"
denied "restored copy: app role cannot rewrite a handoff" "permission denied" q_app opsbridge_app "UPDATE app.consultant_handoffs SET reason='x'"
denied "restored copy: one outbox row per idempotency key" "duplicate key" q "$dst" "INSERT INTO app.outbox (workspace_id, event_type, payload_ref, payload, idempotency_key) SELECT workspace_id, event_type, payload_ref, payload, idempotency_key FROM app.outbox LIMIT 1"
denied "restored copy: one pending approval per case" "approvals_one_pending" q "$dst" "INSERT INTO app.approvals (workspace_id, case_id, proposed_action, requested_by) SELECT workspace_id, case_id, proposed_action, requested_by FROM app.approvals WHERE status='pending' LIMIT 1"
check "restored copy: migrations recorded" "$(q "$dst" "SELECT count(*) FROM ops.schema_migrations")" "$(q "$src" "SELECT count(*) FROM ops.schema_migrations")"
check "restored copy: no-context app read returns nothing but template" \
  "$(q_app opsbridge_app "SELECT count(*) FROM app.workspaces WHERE mode <> 'template'")" "0"

q postgres "DROP DATABASE $dst"
[[ $fail == 0 ]] && echo "RESTORE PROOF PASSED" || { echo "RESTORE PROOF FAILED"; exit 1; }
