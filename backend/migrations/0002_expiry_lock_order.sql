-- P1 carry-forward: reset meeting purge at the expiry boundary. Reset locked the session and
-- then the workspace, purge the other way round, so a workspace expiring mid-reset could
-- deadlock (docs/evidence/P2.0). Purge now takes the session first, the same order as reset.
-- It also leaves a workspace alone for 60 seconds after expiry. app role statements stop at
-- 5 seconds, so anything that passed the session check has finished by then, and a purge can
-- never meet a live request.

CREATE OR REPLACE FUNCTION app.expired_demo_workspaces(batch int) RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT id FROM app.workspaces WHERE mode = 'demo' AND expires_at < now() - interval '60 seconds'
   ORDER BY expires_at LIMIT least(batch, 5);
$$;

CREATE OR REPLACE FUNCTION app.purge_demo_workspace(ws uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE a int; b int := 0; n int; w record;
BEGIN
  -- Lock order matters: session, then workspace, as reset does. A session that reset moves
  -- away while this waits no longer matches and is skipped.
  PERFORM 1 FROM app.demo_sessions WHERE workspace_id = ws ORDER BY id FOR UPDATE;
  SELECT mode, expires_at INTO w FROM app.workspaces WHERE id = ws FOR UPDATE;
  IF NOT FOUND OR w.mode <> 'demo' OR w.expires_at >= now() - interval '60 seconds' THEN
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

-- Same body as 0001 except the expiry update: least() so a reset can never move an old
-- workspace's expiry later and put off its purge.
CREATE OR REPLACE FUNCTION app.reset_demo_session(old_hash bytea, new_hash bytea, bucket bytea)
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
  UPDATE app.workspaces SET expires_at = least(expires_at, now())
   WHERE id = s.workspace_id AND mode = 'demo';
  UPDATE app.demo_sessions d SET workspace_id = ws, token_hash = new_hash,
         expires_at = (SELECT w.expires_at FROM app.workspaces w WHERE w.id = ws),
         quota_counters = jsonb_set(d.quota_counters, '{resets}', to_jsonb(resets + 1))
   WHERE d.id = s.id RETURNING d.* INTO s;
  INSERT INTO app.audit_events (workspace_id, actor_type, actor_id, action, target)
  VALUES (ws, 'demo_session', s.id::text, 'demo.reset', ws::text);
  RETURN QUERY SELECT s.id, ws, s.demo_role, s.expires_at;
END $$;
