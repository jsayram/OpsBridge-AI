-- Workspaces, identity, demo sessions, quota, first business tables, audit and retention.
-- Ported deliberately from spikes/p0.2/sql/001_schema.sql, including the D-012 function
-- boundary. approvals, outbox and idempotency_keys arrive with the phases that use them.
-- Runs as opsbridge_migrator, which therefore owns everything below. RLS relies on the
-- runtime role not owning tables, so never grant it ownership.

CREATE SCHEMA app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO opsbridge_app, opsbridge_cleanup;

CREATE TABLE app.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  mode text NOT NULL CHECK (mode IN ('owner','demo','template')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  seed_clock_shift interval,
  CHECK ((mode = 'demo') = (expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX workspaces_one_template ON app.workspaces (mode) WHERE mode = 'template';
CREATE UNIQUE INDEX workspaces_one_owner ON app.workspaces (mode) WHERE mode = 'owner';
CREATE INDEX workspaces_demo_expiry ON app.workspaces (expires_at) WHERE mode = 'demo';

CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_subject text NOT NULL UNIQUE CHECK (length(oidc_subject) BETWEEN 1 AND 200),
  email_display text,
  active boolean NOT NULL DEFAULT true,
  sessions_valid_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.memberships (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  user_id uuid NOT NULL REFERENCES app.users(id),
  role text NOT NULL CHECK (role IN ('owner')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE app.demo_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  demo_role text NOT NULL DEFAULT 'analyst' CHECK (demo_role IN ('viewer','analyst','manager')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  quota_counters jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX demo_sessions_workspace ON app.demo_sessions (workspace_id);

CREATE TABLE app.demo_quota (
  ip_bucket bytea NOT NULL CHECK (octet_length(ip_bucket) = 32),
  hour timestamptz NOT NULL,
  launches int NOT NULL DEFAULT 0 CHECK (launches >= 0),
  PRIMARY KEY (ip_bucket, hour)
);

-- Limits live here, not in the Worker. Only a migration can change them, so neither a
-- Worker variable nor a leaked runtime credential can stretch the retention rule.
CREATE TABLE app.demo_limits (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  ttl_seconds int NOT NULL DEFAULT 7200 CHECK (ttl_seconds BETWEEN 60 AND 7200),
  workspace_cap int NOT NULL DEFAULT 150 CHECK (workspace_cap > 0),
  hourly_limit int NOT NULL DEFAULT 5 CHECK (hourly_limit > 0),
  reset_limit int NOT NULL DEFAULT 5 CHECK (reset_limit >= 0)
);
INSERT INTO app.demo_limits DEFAULT VALUES;

CREATE TABLE app.customers (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL CHECK (length(canonical_name) BETWEEN 1 AND 200),
  account_code text NOT NULL CHECK (length(account_code) BETWEEN 1 AND 40),
  lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('Prospect','Active','Dormant')),
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  pack_key text,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, account_code),
  UNIQUE (workspace_id, pack_key)
);

CREATE TABLE app.cases (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  case_type text NOT NULL CHECK (case_type IN ('Onboarding','Billing','Renewal','Field issue')),
  status text NOT NULL DEFAULT 'Draft'
    CHECK (status IN ('Draft','Intake','Needs Review','Ready','Approved','Closed')),
  assignee_id uuid,
  due_at timestamptz,
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  pack_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, pack_key),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES app.customers (workspace_id, id)
);
CREATE INDEX cases_workspace_status_created ON app.cases (workspace_id, status, created_at);

CREATE TABLE app.audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  actor_type text NOT NULL CHECK (actor_type IN ('demo_session','owner','system')),
  actor_id text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  before_hash text,
  after_hash text,
  request_id text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_workspace ON app.audit_events (workspace_id, occurred_at);

CREATE TABLE app.retention_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  purged_at timestamptz NOT NULL DEFAULT now(),
  audit_rows int NOT NULL,
  business_rows int NOT NULL
);

-- Append-only guard. Even the table owner hits this. The one exception is PRD 7.4: a
-- delete by a cleanup-role session, which can only arrive through purge_demo_workspace,
-- of rows in a demo workspace that has already expired.
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

-- RLS. Read: own workspace or template. Write: own workspace only. Tables with RLS on and
-- no policy are reachable only through the definer functions below.
ALTER TABLE app.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.demo_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.demo_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.demo_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.retention_log ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION app.current_workspace() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
-- Writes never reach the template, even if a bug sets it as the current workspace.
CREATE FUNCTION app.writable_workspace() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT id FROM app.workspaces WHERE id = app.current_workspace() AND mode <> 'template' $$;

CREATE POLICY ws_read ON app.workspaces FOR SELECT TO opsbridge_app
  USING (id = app.current_workspace() OR mode = 'template');
CREATE POLICY customers_read ON app.customers FOR SELECT TO opsbridge_app USING (
  workspace_id = app.current_workspace()
  OR workspace_id IN (SELECT id FROM app.workspaces WHERE mode = 'template'));
CREATE POLICY customers_ins ON app.customers FOR INSERT TO opsbridge_app
  WITH CHECK (workspace_id = app.writable_workspace());
CREATE POLICY customers_upd ON app.customers FOR UPDATE TO opsbridge_app
  USING (workspace_id = app.writable_workspace()) WITH CHECK (workspace_id = app.writable_workspace());
CREATE POLICY cases_read ON app.cases FOR SELECT TO opsbridge_app USING (
  workspace_id = app.current_workspace()
  OR workspace_id IN (SELECT id FROM app.workspaces WHERE mode = 'template'));
CREATE POLICY cases_ins ON app.cases FOR INSERT TO opsbridge_app
  WITH CHECK (workspace_id = app.writable_workspace());
CREATE POLICY cases_upd ON app.cases FOR UPDATE TO opsbridge_app
  USING (workspace_id = app.writable_workspace()) WITH CHECK (workspace_id = app.writable_workspace());
CREATE POLICY audit_read ON app.audit_events FOR SELECT TO opsbridge_app
  USING (workspace_id = app.current_workspace());
CREATE POLICY audit_ins ON app.audit_events FOR INSERT TO opsbridge_app
  WITH CHECK (workspace_id = app.writable_workspace());

-- Grants. No DELETE or TRUNCATE for the runtime role anywhere, and nothing at all on
-- sessions, quota, users or memberships, so a query bug can't read token hashes.
GRANT SELECT ON app.workspaces TO opsbridge_app;
GRANT SELECT, INSERT, UPDATE ON app.customers, app.cases TO opsbridge_app;
GRANT SELECT, INSERT ON app.audit_events TO opsbridge_app;

-- Demo lifecycle. Everything here acts only on demo workspaces. Internal helpers are not
-- granted to any runtime role.
CREATE FUNCTION app.create_demo_workspace() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE ws uuid; lim app.demo_limits;
BEGIN
  SELECT * INTO lim FROM app.demo_limits;
  -- Counts every unpurged demo workspace, expired ones included, so launches can't
  -- outrun the purge and breach the 24-hour retention rule.
  PERFORM pg_advisory_xact_lock(727001);
  IF (SELECT count(*) FROM app.workspaces WHERE mode = 'demo') >= lim.workspace_cap THEN
    RAISE EXCEPTION 'demo_capacity' USING ERRCODE = 'P0003';
  END IF;
  INSERT INTO app.workspaces (name, mode, expires_at)
  VALUES ('Northstar Operations (fictional)', 'demo', now() + make_interval(secs => lim.ttl_seconds))
  RETURNING id INTO ws;
  RETURN ws;
END $$;

-- One hourly budget per client network for every new workspace, launch or reset. Without
-- reset in here, one address could outrun the purge and fill the cap for everyone.
CREATE FUNCTION app.take_workspace_quota(bucket bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
BEGIN
  INSERT INTO app.demo_quota AS q (ip_bucket, hour, launches)
  VALUES (bucket, date_trunc('hour', now()), 1)
  ON CONFLICT (ip_bucket, hour) DO UPDATE SET launches = q.launches + 1
    WHERE q.launches < (SELECT hourly_limit FROM app.demo_limits);
  IF NOT FOUND OR (SELECT hourly_limit FROM app.demo_limits) < 1 THEN
    RAISE EXCEPTION 'launch_quota' USING ERRCODE = 'P0004';
  END IF;
END $$;

-- Copies the scenario pack (rows with a pack_key) from the template. The same pack always
-- yields the same logical records; only IDs and the recorded clock shift differ.
CREATE FUNCTION app.seed_demo_workspace(ws uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE
  tpl uuid;
  shift interval := now() - timestamptz '2026-01-15 12:00:00+00';
  n int; total int := 0;
BEGIN
  IF NOT EXISTS (SELECT FROM app.workspaces WHERE id = ws AND mode = 'demo') THEN
    RAISE EXCEPTION 'seed target is not a demo workspace' USING ERRCODE = 'P0002';
  END IF;
  SELECT id INTO tpl FROM app.workspaces WHERE mode = 'template';
  IF tpl IS NULL THEN RAISE EXCEPTION 'template_missing' USING ERRCODE = 'P0006'; END IF;
  INSERT INTO app.customers (workspace_id, canonical_name, account_code, lifecycle_status, pack_key)
  SELECT ws, canonical_name, account_code, lifecycle_status, pack_key
    FROM app.customers WHERE workspace_id = tpl AND pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  IF n = 0 THEN RAISE EXCEPTION 'template_missing' USING ERRCODE = 'P0006'; END IF;
  INSERT INTO app.cases (workspace_id, customer_id, title, case_type, status, due_at, pack_key)
  SELECT ws, nc.id, tc.title, tc.case_type, tc.status, tc.due_at + shift, tc.pack_key
    FROM app.cases tc
    JOIN app.customers oc ON oc.workspace_id = tc.workspace_id AND oc.id = tc.customer_id
    JOIN app.customers nc ON nc.workspace_id = ws AND nc.pack_key = oc.pack_key
   WHERE tc.workspace_id = tpl AND tc.pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  UPDATE app.workspaces SET seed_clock_shift = shift WHERE id = ws;
  RETURN total;
END $$;

CREATE FUNCTION app.launch_demo_session(new_hash bytea, bucket bytea)
RETURNS TABLE (session_id uuid, ws_id uuid, role text, session_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp SET lock_timeout = '3s' AS $$
DECLARE ws uuid; s app.demo_sessions;
BEGIN
  PERFORM app.take_workspace_quota(bucket);
  ws := app.create_demo_workspace();
  PERFORM app.seed_demo_workspace(ws);
  INSERT INTO app.demo_sessions (workspace_id, token_hash, expires_at)
  SELECT ws, new_hash, w.expires_at FROM app.workspaces w WHERE w.id = ws RETURNING * INTO s;
  INSERT INTO app.audit_events (workspace_id, actor_type, actor_id, action, target)
  VALUES (ws, 'demo_session', s.id::text, 'demo.launched', ws::text);
  RETURN QUERY SELECT s.id, ws, s.demo_role, s.expires_at;
END $$;

CREATE FUNCTION app.resolve_demo_session(hash bytea)
RETURNS TABLE (session_id uuid, ws_id uuid, role text, session_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT s.id, s.workspace_id, s.demo_role, s.expires_at
    FROM app.demo_sessions s JOIN app.workspaces w ON w.id = s.workspace_id
   WHERE s.token_hash = hash AND s.expires_at > now()
     AND w.mode = 'demo' AND w.expires_at > now();
$$;

-- Reset never deletes. It makes a fresh workspace, moves the session to it, rotates the
-- token so the old cookie dies, and expires the old workspace for the sweep to purge.
CREATE FUNCTION app.reset_demo_session(old_hash bytea, new_hash bytea, bucket bytea)
RETURNS TABLE (session_id uuid, ws_id uuid, role text, session_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp SET lock_timeout = '3s' AS $$
DECLARE s app.demo_sessions; ws uuid; resets int;
BEGIN
  SELECT d.* INTO s FROM app.demo_sessions d JOIN app.workspaces w ON w.id = d.workspace_id
   WHERE d.token_hash = old_hash AND d.expires_at > now() AND w.mode = 'demo' AND w.expires_at > now()
   FOR UPDATE OF d;
  IF NOT FOUND THEN RETURN; END IF;
  resets := coalesce((s.quota_counters ->> 'resets')::int, 0);
  IF resets >= (SELECT reset_limit FROM app.demo_limits) THEN
    RAISE EXCEPTION 'reset_quota' USING ERRCODE = 'P0005';
  END IF;
  PERFORM app.take_workspace_quota(bucket);
  ws := app.create_demo_workspace();
  PERFORM app.seed_demo_workspace(ws);
  UPDATE app.workspaces SET expires_at = now() WHERE id = s.workspace_id AND mode = 'demo';
  UPDATE app.demo_sessions d SET workspace_id = ws, token_hash = new_hash,
         expires_at = (SELECT w.expires_at FROM app.workspaces w WHERE w.id = ws),
         quota_counters = jsonb_set(d.quota_counters, '{resets}', to_jsonb(resets + 1))
   WHERE d.id = s.id RETURNING d.* INTO s;
  INSERT INTO app.audit_events (workspace_id, actor_type, actor_id, action, target)
  VALUES (ws, 'demo_session', s.id::text, 'demo.reset', ws::text);
  RETURN QUERY SELECT s.id, ws, s.demo_role, s.expires_at;
END $$;

CREATE FUNCTION app.set_demo_role(hash bytea, new_role text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE s app.demo_sessions;
BEGIN
  UPDATE app.demo_sessions d SET demo_role = new_role
    FROM app.workspaces w
   WHERE d.token_hash = hash AND w.id = d.workspace_id AND d.expires_at > now()
     AND w.mode = 'demo' AND w.expires_at > now()
  RETURNING d.* INTO s;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO app.audit_events (workspace_id, actor_type, actor_id, action, target)
  VALUES (s.workspace_id, 'demo_session', s.id::text, 'demo.role_switched', new_role);
  RETURN s.demo_role;
END $$;

-- Owner identity. Called only after the JWT and the subject allowlist pass in the Worker.
CREATE FUNCTION app.resolve_owner(subject text)
RETURNS TABLE (user_id uuid, ws_id uuid, active boolean, sessions_valid_after timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
#variable_conflict use_column
DECLARE ws uuid; u app.users;
BEGIN
  SELECT id INTO ws FROM app.workspaces WHERE mode = 'owner';
  IF ws IS NULL THEN RAISE EXCEPTION 'owner_workspace_missing' USING ERRCODE = 'P0007'; END IF;
  INSERT INTO app.users (oidc_subject) VALUES (subject) ON CONFLICT (oidc_subject) DO NOTHING;
  SELECT * INTO u FROM app.users WHERE oidc_subject = subject;
  INSERT INTO app.memberships (workspace_id, user_id, role) VALUES (ws, u.id, 'owner')
    ON CONFLICT DO NOTHING;
  RETURN QUERY SELECT u.id, ws, u.active, u.sessions_valid_after;
END $$;

CREATE FUNCTION app.revoke_owner_sessions(subject text, req text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE ws uuid; uid uuid;
BEGIN
  UPDATE app.users SET sessions_valid_after = now() WHERE oidc_subject = subject RETURNING id INTO uid;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT id INTO ws FROM app.workspaces WHERE mode = 'owner';
  INSERT INTO app.audit_events (workspace_id, actor_type, actor_id, action, target, request_id)
  VALUES (ws, 'owner', uid::text, 'owner.logout', uid::text, req);
  RETURN true;
END $$;

-- Cleanup. Definer rights live here so the cleanup role needs no table privilege, and
-- owner or template rows are out of its reach. At most 5 workspaces a run (PRD 7.4).
CREATE FUNCTION app.expired_demo_workspaces(batch int) RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT id FROM app.workspaces WHERE mode = 'demo' AND expires_at < now()
   ORDER BY expires_at LIMIT least(batch, 5);
$$;

CREATE FUNCTION app.purge_demo_workspace(ws uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE a int; b int := 0; n int; w record;
BEGIN
  SELECT mode, expires_at INTO w FROM app.workspaces WHERE id = ws FOR UPDATE;
  IF NOT FOUND OR w.mode <> 'demo' OR w.expires_at >= now() THEN
    RAISE EXCEPTION 'refusing to purge workspace %', ws USING ERRCODE = 'P0002';
  END IF;
  DELETE FROM app.audit_events WHERE workspace_id = ws; GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM app.cases WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.customers WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.demo_sessions WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.workspaces WHERE id = ws;
  INSERT INTO app.retention_log (workspace_id, audit_rows, business_rows) VALUES (ws, a, b);
  RETURN a + b;
END $$;

CREATE FUNCTION app.purge_stale_demo_quota() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE n int;
BEGIN
  DELETE FROM app.demo_quota WHERE hour < now() - interval '2 hours';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.current_workspace(),
  app.writable_workspace(),
  app.launch_demo_session(bytea, bytea),
  app.resolve_demo_session(bytea),
  app.reset_demo_session(bytea, bytea, bytea),
  app.set_demo_role(bytea, text),
  app.resolve_owner(text),
  app.revoke_owner_sessions(text, text)
TO opsbridge_app;
GRANT EXECUTE ON FUNCTION
  app.expired_demo_workspaces(int),
  app.purge_demo_workspace(uuid),
  app.purge_stale_demo_quota()
TO opsbridge_cleanup;
