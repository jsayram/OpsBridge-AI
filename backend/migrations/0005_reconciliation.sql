-- P3.4: the reconciliation queue goes live, so the runtime role gets the writes it needs, and
-- the sweep returns deferred findings to the queue.
GRANT INSERT, UPDATE ON app.reconciliation_findings TO opsbridge_app;
GRANT INSERT ON app.external_record_links, app.customer_source_relationships,
  app.source_definition_mappings TO opsbridge_app;

-- The cleanup role has no table rights, so this is its only path. It audits as the system and
-- stops for a workspace at its write cap rather than failing the sweep.
CREATE FUNCTION app.release_deferred_findings(batch int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT workspace_id, id FROM app.reconciliation_findings
            WHERE status = 'Deferred' AND defer_until <= now()
            ORDER BY defer_until LIMIT batch FOR UPDATE SKIP LOCKED LOOP
    BEGIN
      INSERT INTO app.audit_events (workspace_id, actor_type, actor_id, actor_role, action, target, summary)
      VALUES (r.workspace_id, 'system', 'sweep', 'system', 'finding.undeferred', r.id::text,
              'Deferral date passed, back in the queue');
      UPDATE app.reconciliation_findings
         SET status = 'Open', defer_until = NULL, version = version + 1
       WHERE workspace_id = r.workspace_id AND id = r.id;
      n := n + 1;
    EXCEPTION WHEN SQLSTATE 'P0008' THEN
      NULL;
    END;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION app.release_deferred_findings(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.release_deferred_findings(int) TO opsbridge_cleanup;
