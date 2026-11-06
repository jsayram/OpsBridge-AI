-- ADR-000 proof schema: the smallest subset that exercises approval atomicity,
-- least-privilege roles, RLS isolation, append-only audit and demo cleanup.
-- Run as the local admin. Not the application migration set.
DROP SCHEMA IF EXISTS app CASCADE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='opsbridge_app') THEN
    CREATE ROLE opsbridge_app LOGIN PASSWORD 'local_dev_only' NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='opsbridge_cleanup') THEN
    CREATE ROLE opsbridge_cleanup LOGIN PASSWORD 'local_dev_only' NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF;
END $$;
CREATE SCHEMA app;
GRANT USAGE ON SCHEMA app TO opsbridge_app, opsbridge_cleanup;

CREATE TABLE app.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('owner','demo','template')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CHECK ((mode = 'demo') = (expires_at IS NOT NULL))
);
CREATE TABLE app.cases (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','approved','closed')),
  version int NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE app.approvals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  case_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  actor text,
  decided_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, case_id) REFERENCES app.cases(workspace_id, id)
);
CREATE TABLE app.outbox (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  event_type text NOT NULL,
  idempotency_key text NOT NULL,
  dispatch_state text NOT NULL DEFAULT 'pending'
    CHECK (dispatch_state IN ('pending','processing','retry_scheduled','accepted','simulated','dead_letter')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX outbox_due ON app.outbox (next_attempt_at) WHERE dispatch_state IN ('pending','retry_scheduled','processing');
CREATE TABLE app.audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  actor text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.retention_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  purged_at timestamptz NOT NULL DEFAULT now(),
  audit_rows int NOT NULL,
  business_rows int NOT NULL
);

-- Append-only guard. Even the table owner hits this. Only the cleanup role may
-- delete, and only rows of a demo workspace that has already expired.
CREATE FUNCTION app.audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w record;
BEGIN
  IF TG_OP = 'DELETE' AND session_user = 'opsbridge_cleanup' THEN
    SELECT mode, expires_at INTO w FROM app.workspaces WHERE id = OLD.workspace_id;
    IF w.mode = 'demo' AND w.expires_at < now() THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only (% by %)', TG_OP, session_user USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER audit_guard BEFORE UPDATE OR DELETE ON app.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_guard();
CREATE FUNCTION app.audit_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_events is append-only (TRUNCATE)'; END $$;
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON app.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_no_truncate();

-- RLS: app role sees its own workspace; template rows are read-only for everyone.
ALTER TABLE app.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION app.current_workspace() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
CREATE POLICY ws_read ON app.workspaces FOR SELECT TO opsbridge_app USING (
  id = app.current_workspace() OR mode = 'template');
CREATE POLICY cases_read ON app.cases FOR SELECT TO opsbridge_app USING (
  workspace_id = app.current_workspace()
  OR workspace_id IN (SELECT id FROM app.workspaces WHERE mode='template'));
CREATE POLICY cases_ins ON app.cases FOR INSERT TO opsbridge_app WITH CHECK (workspace_id = app.current_workspace());
CREATE POLICY cases_upd ON app.cases FOR UPDATE TO opsbridge_app
  USING (workspace_id = app.current_workspace()) WITH CHECK (workspace_id = app.current_workspace());
CREATE POLICY appr_all ON app.approvals FOR ALL TO opsbridge_app
  USING (workspace_id = app.current_workspace()) WITH CHECK (workspace_id = app.current_workspace());
CREATE POLICY outbox_all ON app.outbox FOR ALL TO opsbridge_app
  USING (workspace_id = app.current_workspace()) WITH CHECK (workspace_id = app.current_workspace());
CREATE POLICY audit_read ON app.audit_events FOR SELECT TO opsbridge_app USING (workspace_id = app.current_workspace());
CREATE POLICY audit_ins ON app.audit_events FOR INSERT TO opsbridge_app WITH CHECK (workspace_id = app.current_workspace());

-- Grants. No DELETE or TRUNCATE for the runtime role anywhere.
-- Workspaces change only through the narrow functions below: never a direct UPDATE,
-- so no bug in the request path can flip a mode or expire an owner workspace.
GRANT SELECT ON app.workspaces TO opsbridge_app;
GRANT SELECT, INSERT, UPDATE ON app.cases, app.approvals, app.outbox TO opsbridge_app;
GRANT SELECT, INSERT ON app.audit_events TO opsbridge_app;
-- The cleanup role has no table rights at all, only EXECUTE on the purge functions.

-- Dispatcher runs across workspaces but only through this narrow definer function.
CREATE FUNCTION app.claim_due_outbox(batch int, lease_seconds int)
RETURNS SETOF app.outbox LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
BEGIN
  -- A Worker killed on every attempt must still end: reclaims stop at the attempt cap.
  UPDATE app.outbox SET dispatch_state='dead_letter', lease_expires_at=NULL
   WHERE dispatch_state='processing' AND lease_expires_at < now() AND attempts >= 6;
  RETURN QUERY
  UPDATE app.outbox o SET dispatch_state='processing', attempts=attempts+1,
         lease_expires_at = now() + make_interval(secs => lease_seconds)
  WHERE (o.workspace_id, o.id) IN (
    SELECT x.workspace_id, x.id FROM app.outbox x JOIN app.workspaces w ON w.id = x.workspace_id
    WHERE w.mode <> 'template'
      AND ((x.dispatch_state IN ('pending','retry_scheduled') AND x.next_attempt_at <= now())
        OR (x.dispatch_state='processing' AND x.lease_expires_at < now()))
    ORDER BY x.next_attempt_at LIMIT batch FOR UPDATE OF x SKIP LOCKED)
  RETURNING o.*;
END $$;
CREATE FUNCTION app.finish_outbox(ws uuid, oid uuid, new_state text, retry_seconds int DEFAULT 0)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp AS $$
  UPDATE app.outbox SET dispatch_state=new_state, lease_expires_at=NULL,
         next_attempt_at = now() + make_interval(secs => retry_seconds)
  WHERE workspace_id=ws AND id=oid AND dispatch_state='processing';
$$;
REVOKE ALL ON FUNCTION app.claim_due_outbox(int,int), app.finish_outbox(uuid,uuid,text,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_due_outbox(int,int), app.finish_outbox(uuid,uuid,text,int) TO opsbridge_app;

-- Demo lifecycle. The runtime role calls these and cannot do anything else to workspaces.
-- Capacity counts every unpurged demo workspace, expired ones included, so launches
-- cannot outrun the purge and breach the 24-hour retention rule.
CREATE FUNCTION app.create_demo_workspace(ttl_seconds int, cap int) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE ws uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(727001);
  IF (SELECT count(*) FROM app.workspaces WHERE mode='demo') >= cap THEN
    RAISE EXCEPTION 'demo_capacity' USING ERRCODE='P0003';
  END IF;
  INSERT INTO app.workspaces(name,mode,expires_at) VALUES ('demo','demo',now()+make_interval(secs=>ttl_seconds)) RETURNING id INTO ws;
  RETURN ws;
END $$;
CREATE FUNCTION app.expire_demo_workspace() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
BEGIN
  UPDATE app.workspaces SET expires_at = now()
   WHERE id = app.current_workspace() AND mode='demo' AND expires_at > now();
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app.create_demo_workspace(int,int), app.expire_demo_workspace() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_demo_workspace(int,int), app.expire_demo_workspace() TO opsbridge_app;

-- Bounded purge of one expired demo workspace. Definer rights live here so the cleanup
-- role needs no table privilege, and owner or template rows are out of its reach.
CREATE FUNCTION app.expired_demo_workspaces(batch int) RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT id FROM app.workspaces WHERE mode='demo' AND expires_at < now() ORDER BY expires_at LIMIT batch;
$$;
CREATE FUNCTION app.purge_demo_workspace(ws uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE a int; b int := 0; n int; w record;
BEGIN
  SELECT mode, expires_at INTO w FROM app.workspaces WHERE id = ws FOR UPDATE;
  IF NOT FOUND OR w.mode <> 'demo' OR w.expires_at >= now() THEN
    RAISE EXCEPTION 'refusing to purge workspace %', ws USING ERRCODE='P0002';
  END IF;
  DELETE FROM app.audit_events WHERE workspace_id = ws; GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM app.outbox WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.approvals WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.cases WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.workspaces WHERE id = ws;
  INSERT INTO app.retention_log(workspace_id, audit_rows, business_rows) VALUES (ws, a, b);
  RETURN a + b;
END $$;
REVOKE ALL ON FUNCTION app.purge_demo_workspace(uuid), app.expired_demo_workspaces(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_demo_workspace(uuid), app.expired_demo_workspaces(int) TO opsbridge_cleanup;
