-- P6.1: executive analytics (PRD 11, docs/design/METRICS.md).
-- Live metrics are computed on request from the transactional tables, so they always reconcile.
-- metric_snapshots keeps one value per workspace, UTC day and metric, for trends. The shared
-- template holds a fixed 90-day synthetic history; a workspace can record its own day.

CREATE TABLE app.metric_snapshots (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  period date NOT NULL,
  metric_key text NOT NULL CHECK (metric_key IN
    ('open_cases','completed_cases','review_queue','open_findings','automation_failed')),
  numerator numeric(12,2) NOT NULL CHECK (numerator >= 0),
  -- Empty for a plain count. A rate stores both parts, never the division.
  denominator numeric(12,2) CHECK (denominator > 0),
  provenance text NOT NULL CHECK (provenance IN ('SYNTHETIC','MEASURED_DEMO','ESTIMATED','UNKNOWN')),
  definition_version text NOT NULL CHECK (definition_version ~ '^[a-z0-9.-]{1,20}$'),
  assumptions_version text CHECK (assumptions_version ~ '^[a-z0-9.-]{1,20}$'),
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, metric_key, period)
);

ALTER TABLE app.metric_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY metric_snapshots_read ON app.metric_snapshots FOR SELECT TO opsbridge_app USING (
  workspace_id = app.current_workspace()
  OR workspace_id IN (SELECT id FROM app.workspaces WHERE mode = 'template'));
CREATE POLICY metric_snapshots_ins ON app.metric_snapshots FOR INSERT TO opsbridge_app
  WITH CHECK (workspace_id = app.writable_workspace());
CREATE POLICY metric_snapshots_upd ON app.metric_snapshots FOR UPDATE TO opsbridge_app
  USING (workspace_id = app.writable_workspace())
  WITH CHECK (workspace_id = app.writable_workspace());
GRANT SELECT, INSERT, UPDATE ON app.metric_snapshots TO opsbridge_app;

-- Replaces 0008's copy: a workspace's own snapshots go with it.
CREATE OR REPLACE FUNCTION app.purge_demo_workspace(ws uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE a int; b int := 0; n int; w record;
BEGIN
  PERFORM 1 FROM app.demo_sessions WHERE workspace_id = ws ORDER BY id FOR UPDATE;
  SELECT mode, expires_at INTO w FROM app.workspaces WHERE id = ws FOR UPDATE;
  IF NOT FOUND OR w.mode <> 'demo' OR w.expires_at >= now() - interval '60 seconds' THEN
    RAISE EXCEPTION 'refusing to purge workspace %', ws USING ERRCODE = 'P0002';
  END IF;
  DELETE FROM app.audit_events WHERE workspace_id = ws; GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM app.idempotency_keys WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.automation_effects WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.outbox_attempts WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.outbox WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.metric_snapshots WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.ai_usage WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.ai_reviews WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.documents WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.approvals WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.consultant_handoffs WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.case_checklist_items WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.reconciliation_findings WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.inventory_snapshots WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.inventory_items WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.invoices WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.contacts WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.source_definition_mappings WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.source_records WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.sync_runs WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.customer_source_relationships WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.external_record_links WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.external_connections WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  -- Reused rules point at their source, so they go first.
  DELETE FROM app.workflow_rules WHERE workspace_id = ws AND reused_from IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.workflow_rules WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.cases WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.assignees WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.customers WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.demo_sessions WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.workspaces WHERE id = ws;
  INSERT INTO app.retention_log (workspace_id, audit_rows, business_rows) VALUES (ws, a, b);
  RETURN a + b;
END $$;
