-- P3.1 and P3.2: connections, sync runs, the source record store, invoices, contacts and the
-- definition mappings. Same conventions as 0003: composite keys, RLS, reads through
-- own-or-template, writes through app.writable_workspace(). Findings and inventory get their
-- grants in the migrations of the packages that write them (D-028).

ALTER TABLE app.external_record_links DROP CONSTRAINT external_record_links_provider_check;
ALTER TABLE app.external_record_links ADD CONSTRAINT external_record_links_provider_check
  CHECK (provider IN ('crm_simulator','erp_simulator','inventory_simulator','salesforce_test'));

CREATE TABLE app.external_connections (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL
    CHECK (provider IN ('crm_simulator','erp_simulator','inventory_simulator','salesforce_test')),
  mode text NOT NULL CHECK (mode IN ('simulated','connected_test')),
  status text NOT NULL CHECK (status IN ('Not Configured','Simulated','Connected Test','Degraded','Disconnected')),
  scopes text[] NOT NULL DEFAULT '{}',
  -- An opaque pointer into app.connection_secrets. Never a token.
  secret_reference uuid,
  last_cursor text CHECK (length(last_cursor) <= 400),
  last_success_at timestamptz,
  last_error_code text CHECK (length(last_error_code) <= 60),
  simulator_shift interval NOT NULL DEFAULT '0',
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  pack_key text,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, provider),
  UNIQUE (workspace_id, pack_key),
  CHECK ((provider = 'salesforce_test') = (mode = 'connected_test'))
);

-- A live connection can exist only in the owner workspace, whatever the application does.
CREATE FUNCTION app.connection_mode_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
BEGIN
  IF NEW.mode <> 'simulated'
     AND (SELECT mode FROM app.workspaces WHERE id = NEW.workspace_id) <> 'owner' THEN
    RAISE EXCEPTION 'live connections are owner-only' USING ERRCODE = 'P0009';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_mode_guard BEFORE INSERT OR UPDATE ON app.external_connections
  FOR EACH ROW EXECUTE FUNCTION app.connection_mode_guard();

CREATE TABLE app.sync_runs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  provider text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('full','delta')),
  scenario text NOT NULL DEFAULT 'baseline' CHECK (scenario ~ '^[a-z0-9_]{1,40}$'),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','succeeded','failed','dead_letter')),
  -- Position inside this run, written with the page it follows. The connection's own cursor
  -- moves only when the whole run succeeds.
  cursor text CHECK (length(cursor) <= 400),
  since_cursor text CHECK (length(since_cursor) <= 400),
  high_watermark timestamptz,
  pages int NOT NULL DEFAULT 0 CHECK (pages >= 0),
  counts jsonb NOT NULL DEFAULT '{}',
  resumes int NOT NULL DEFAULT 0 CHECK (resumes BETWEEN 0 AND 5),
  error_class text CHECK (error_class IN ('transient','rate_limited','auth','permission','invalid_payload','cursor')),
  error_code text CHECK (length(error_code) <= 60),
  lease_token uuid,
  lease_expires_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES app.external_connections (workspace_id, id),
  CHECK ((status = 'running') = (ended_at IS NULL)),
  CHECK (status NOT IN ('failed','dead_letter') OR error_code IS NOT NULL)
);
CREATE UNIQUE INDEX sync_runs_one_running ON app.sync_runs (workspace_id, connection_id)
  WHERE status = 'running';
CREATE INDEX sync_runs_connection ON app.sync_runs (workspace_id, connection_id, started_at DESC);

-- PRD 7.1: provider data stays minimal and apart from canonical records. data holds only fields
-- the mappers allow, so nothing unmapped can land here.
CREATE TABLE app.source_records (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  provider text NOT NULL,
  external_type text NOT NULL CHECK (length(external_type) BETWEEN 1 AND 60),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 120),
  external_version text NOT NULL CHECK (length(external_version) BETWEEN 1 AND 60),
  source_modified_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  content_hash text NOT NULL CHECK (length(content_hash) = 64),
  data jsonb NOT NULL CHECK (pg_column_size(data) <= 2048),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','deleted')),
  last_seen_run uuid NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, provider, external_type, external_id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES app.external_connections (workspace_id, id)
);

CREATE TABLE app.invoices (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('erp_simulator')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 120),
  tran_number text NOT NULL CHECK (length(tran_number) BETWEEN 1 AND 60),
  -- The specific bill-to is kept even when customer_id is known (PRD 7.3).
  bill_to_external_id text NOT NULL CHECK (length(bill_to_external_id) BETWEEN 1 AND 120),
  customer_id uuid,
  amount numeric(12,2) NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  tran_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('Open','Paid Partially','Paid In Full')),
  source_modified_at timestamptz NOT NULL,
  pack_key text,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, provider, external_id),
  UNIQUE (workspace_id, pack_key),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES app.customers (workspace_id, id)
);
CREATE INDEX invoices_bill_to ON app.invoices (workspace_id, bill_to_external_id);

CREATE TABLE app.contacts (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  email_display text NOT NULL CHECK (email_display ~ '@example\.com$'),
  pack_key text,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, pack_key),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES app.customers (workspace_id, id)
);

CREATE TABLE app.source_definition_mappings (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  entity_type text NOT NULL CHECK (entity_type IN ('customer','inventory_item')),
  source_definition_version text NOT NULL CHECK (length(source_definition_version) BETWEEN 1 AND 40),
  canonical_definition_version text NOT NULL CHECK (length(canonical_definition_version) BETWEEN 1 AND 40),
  mapping_rule_ref text NOT NULL CHECK (length(mapping_rule_ref) BETWEEN 1 AND 40),
  field_authority jsonb NOT NULL,
  steward_role text NOT NULL CHECK (length(steward_role) BETWEEN 1 AND 60),
  approved_by text NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 120),
  approved_at timestamptz NOT NULL,
  rationale text CHECK (length(rationale) <= 500),
  pack_key text,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, pack_key)
);

-- Encrypted provider tokens. Only the owner workspace can hold a row, and the runtime role can't
-- delete, so disconnect scrubs the ciphertext in place. The key is a Worker secret, never here.
CREATE TABLE app.connection_secrets (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('salesforce_test')),
  ciphertext bytea,
  iv bytea CHECK (octet_length(iv) = 12),
  key_version int NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  scrubbed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  CHECK ((ciphertext IS NULL) = (scrubbed_at IS NOT NULL))
);

CREATE TABLE app.oauth_states (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  state_hash bytea NOT NULL CHECK (octet_length(state_hash) = 32),
  verifier_ciphertext bytea NOT NULL,
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (workspace_id, state_hash)
);

CREATE FUNCTION app.owner_only_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
BEGIN
  IF (SELECT mode FROM app.workspaces WHERE id = NEW.workspace_id) <> 'owner' THEN
    RAISE EXCEPTION 'owner-only table' USING ERRCODE = 'P0009';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_secrets_owner BEFORE INSERT ON app.connection_secrets
  FOR EACH ROW EXECUTE FUNCTION app.owner_only_row();
CREATE TRIGGER oauth_states_owner BEFORE INSERT ON app.oauth_states
  FOR EACH ROW EXECUTE FUNCTION app.owner_only_row();

-- Columns the reconciliation queue needs. subject is what a finding is about, dedupe_key is
-- subject plus the exact evidence, so a replay of the same facts can't add a row (P3-B).
ALTER TABLE app.reconciliation_findings
  ALTER COLUMN entity_id DROP NOT NULL,
  DROP CONSTRAINT reconciliation_findings_entity_type_check,
  ADD CONSTRAINT reconciliation_findings_entity_type_check
    CHECK (entity_type IN ('customer','inventory_item','source_record')),
  ADD COLUMN subject text NOT NULL DEFAULT '' CHECK (length(subject) <= 160),
  ADD COLUMN dedupe_key text CHECK (length(dedupe_key) <= 220),
  ADD COLUMN proposal text CHECK (length(proposal) <= 500),
  ADD COLUMN resolution_note text CHECK (length(resolution_note) <= 500),
  ADD COLUMN resolved_by text CHECK (length(resolved_by) <= 120),
  ADD COLUMN detected_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT reconciliation_findings_customer_entity
    CHECK (entity_type = 'source_record' OR entity_id IS NOT NULL),
  ADD CONSTRAINT reconciliation_findings_terminal
    CHECK ((status IN ('Resolved','Dismissed')) = (resolved_at IS NOT NULL));
CREATE UNIQUE INDEX reconciliation_findings_dedupe ON app.reconciliation_findings (workspace_id, dedupe_key);
CREATE INDEX reconciliation_findings_queue
  ON app.reconciliation_findings (workspace_id, detected_at DESC, id DESC);
CREATE INDEX reconciliation_findings_subject ON app.reconciliation_findings (workspace_id, subject);
CREATE INDEX reconciliation_findings_deferred ON app.reconciliation_findings (defer_until)
  WHERE status = 'Deferred';

ALTER TABLE app.inventory_snapshots
  ADD COLUMN location text CHECK (length(location) <= 80),
  ADD COLUMN item_code text CHECK (length(item_code) <= 40);
CREATE INDEX inventory_snapshots_item ON app.inventory_snapshots (workspace_id, item_id);

ALTER TABLE app.consultant_handoffs
  ADD COLUMN inventory_item_id uuid,
  ADD FOREIGN KEY (workspace_id, inventory_item_id) REFERENCES app.inventory_items (workspace_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['external_connections','sync_runs','source_records','invoices',
    'contacts','source_definition_mappings'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY %1$s_read ON app.%1$I FOR SELECT TO opsbridge_app USING (
      workspace_id = app.current_workspace()
      OR workspace_id IN (SELECT id FROM app.workspaces WHERE mode = 'template'))$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_ins ON app.%1$I FOR INSERT TO opsbridge_app
      WITH CHECK (workspace_id = app.writable_workspace())$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_upd ON app.%1$I FOR UPDATE TO opsbridge_app
      USING (workspace_id = app.writable_workspace())
      WITH CHECK (workspace_id = app.writable_workspace())$f$, t);
  END LOOP;
  -- Tokens and OAuth state are never shared, not even with the template.
  FOREACH t IN ARRAY ARRAY['connection_secrets','oauth_states'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY %1$s_read ON app.%1$I FOR SELECT TO opsbridge_app
      USING (workspace_id = app.current_workspace())$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_ins ON app.%1$I FOR INSERT TO opsbridge_app
      WITH CHECK (workspace_id = app.writable_workspace())$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_upd ON app.%1$I FOR UPDATE TO opsbridge_app
      USING (workspace_id = app.writable_workspace())
      WITH CHECK (workspace_id = app.writable_workspace())$f$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON app.external_connections, app.sync_runs, app.source_records,
  app.invoices, app.connection_secrets, app.oauth_states TO opsbridge_app;
GRANT SELECT ON app.contacts, app.source_definition_mappings TO opsbridge_app;
-- A sync stamps last_seen on the links it reads.
GRANT UPDATE ON app.external_record_links TO opsbridge_app;

-- Moves the source timestamps in stored evidence with the rest of a pack's dates.
CREATE FUNCTION app.shift_evidence(evidence jsonb, shift interval) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN jsonb_typeof(evidence -> 'sources') = 'array' THEN
    jsonb_set(evidence, '{sources}', coalesce((
      SELECT jsonb_agg(CASE WHEN s ? 'sourceTimestamp' THEN jsonb_set(s, '{sourceTimestamp}',
               to_jsonb(to_char(((s ->> 'sourceTimestamp')::timestamptz + shift) AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) ELSE s END ORDER BY ord)
        FROM jsonb_array_elements(evidence -> 'sources') WITH ORDINALITY AS e(s, ord)), '[]'))
  ELSE evidence END
$$;

CREATE OR REPLACE FUNCTION app.seed_demo_workspace(ws uuid) RETURNS int
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

  INSERT INTO app.assignees (workspace_id, display_name, team, can_receive_cases, active, pack_key)
  SELECT ws, display_name, team, can_receive_cases, active, pack_key
    FROM app.assignees WHERE workspace_id = tpl AND pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  INSERT INTO app.cases (workspace_id, customer_id, title, case_type, status, due_at, pack_key,
                         queue, assignee_id, created_at)
  SELECT ws, nc.id, tc.title, tc.case_type, tc.status, tc.due_at + shift, tc.pack_key,
         tc.queue, na.id, tc.created_at + shift
    FROM app.cases tc
    JOIN app.customers oc ON oc.workspace_id = tc.workspace_id AND oc.id = tc.customer_id
    JOIN app.customers nc ON nc.workspace_id = ws AND nc.pack_key = oc.pack_key
    LEFT JOIN app.assignees oa ON oa.workspace_id = tc.workspace_id AND oa.id = tc.assignee_id
    LEFT JOIN app.assignees na ON na.workspace_id = ws AND na.pack_key = oa.pack_key
   WHERE tc.workspace_id = tpl AND tc.pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  INSERT INTO app.case_checklist_items (workspace_id, case_id, item_key, label, position, required, state)
  SELECT ws, nc.id, i.item_key, i.label, i.position, i.required, i.state
    FROM app.case_checklist_items i
    JOIN app.cases oc ON oc.workspace_id = i.workspace_id AND oc.id = i.case_id
    JOIN app.cases nc ON nc.workspace_id = ws AND nc.pack_key = oc.pack_key
   WHERE i.workspace_id = tpl AND oc.pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  INSERT INTO app.approvals (workspace_id, case_id, proposed_action, proposed_payload, status, requested_by)
  SELECT ws, nc.id, a.proposed_action, a.proposed_payload, a.status, a.requested_by
    FROM app.approvals a
    JOIN app.cases oc ON oc.workspace_id = a.workspace_id AND oc.id = a.case_id
    JOIN app.cases nc ON nc.workspace_id = ws AND nc.pack_key = oc.pack_key
   WHERE a.workspace_id = tpl AND oc.pack_key IS NOT NULL AND a.status = 'pending';
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  INSERT INTO app.documents (workspace_id, case_id, title, fixture_id, category, status, pack_key)
  SELECT ws, nc.id, d.title, d.fixture_id, d.category, d.status, d.pack_key
    FROM app.documents d
    JOIN app.cases oc ON oc.workspace_id = d.workspace_id AND oc.id = d.case_id
    JOIN app.cases nc ON nc.workspace_id = ws AND nc.pack_key = oc.pack_key
   WHERE d.workspace_id = tpl AND d.pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  INSERT INTO app.ai_reviews (workspace_id, document_id, model_version, prompt_version,
                              extraction, citations, status, abstain_reason)
  SELECT ws, nd.id, r.model_version, r.prompt_version, r.extraction, r.citations, r.status, r.abstain_reason
    FROM app.ai_reviews r
    JOIN app.documents od ON od.workspace_id = r.workspace_id AND od.id = r.document_id
    JOIN app.documents nd ON nd.workspace_id = ws AND nd.pack_key = od.pack_key
   WHERE r.workspace_id = tpl AND od.pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  -- Simulator clocks move with the pack, so a source timestamp reads as recent on any launch.
  INSERT INTO app.external_connections (workspace_id, provider, mode, status, scopes,
                                        simulator_shift, created_at, pack_key)
  SELECT ws, provider, mode, status, scopes, shift, created_at + shift, pack_key
    FROM app.external_connections WHERE workspace_id = tpl AND pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  INSERT INTO app.external_record_links (workspace_id, provider, external_type, external_id,
                                         canonical_type, canonical_id, last_seen, pack_key)
  SELECT ws, l.provider, l.external_type, l.external_id, l.canonical_type, nc.id,
         l.last_seen + shift, l.pack_key
    FROM app.external_record_links l
    JOIN app.customers oc ON oc.workspace_id = l.workspace_id AND oc.id = l.canonical_id
    JOIN app.customers nc ON nc.workspace_id = ws AND nc.pack_key = oc.pack_key
   WHERE l.workspace_id = tpl AND l.pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  INSERT INTO app.customer_source_relationships (workspace_id, customer_id, external_record_link_id,
                                                 relationship_role, mapping_version, approved_by, approved_at)
  SELECT ws, nc.id, nl.id, r.relationship_role, r.mapping_version, r.approved_by, r.approved_at + shift
    FROM app.customer_source_relationships r
    JOIN app.customers oc ON oc.workspace_id = r.workspace_id AND oc.id = r.customer_id
    JOIN app.customers nc ON nc.workspace_id = ws AND nc.pack_key = oc.pack_key
    JOIN app.external_record_links ol ON ol.workspace_id = r.workspace_id AND ol.id = r.external_record_link_id
    JOIN app.external_record_links nl ON nl.workspace_id = ws AND nl.pack_key = ol.pack_key
   WHERE r.workspace_id = tpl;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  -- entity_id stays empty for a finding about a source record no customer owns yet.
  INSERT INTO app.reconciliation_findings (workspace_id, entity_type, entity_id, kind, severity,
    source_values, status, pack_key, subject, dedupe_key, proposal, detected_at)
  SELECT ws, f.entity_type, nc.id, f.kind, f.severity, app.shift_evidence(f.source_values, shift),
         f.status, f.pack_key, f.subject, f.dedupe_key, f.proposal, f.detected_at + shift
    FROM app.reconciliation_findings f
    LEFT JOIN app.customers oc ON oc.workspace_id = f.workspace_id AND oc.id = f.entity_id
    LEFT JOIN app.customers nc ON nc.workspace_id = ws AND nc.pack_key = oc.pack_key
   WHERE f.workspace_id = tpl AND f.pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  INSERT INTO app.inventory_items (workspace_id, canonical_item_code, description, canonical_unit,
                                   lifecycle_status, pack_key)
  SELECT ws, canonical_item_code, description, canonical_unit, lifecycle_status, pack_key
    FROM app.inventory_items WHERE workspace_id = tpl AND pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  INSERT INTO app.inventory_snapshots (workspace_id, item_id, unresolved_source_ref, provider,
    external_id, quantity, unit, source_version, observed_at, ingested_at, pack_key, location, item_code)
  SELECT ws, ni.id, s.unresolved_source_ref, s.provider, s.external_id, s.quantity, s.unit,
         s.source_version, s.observed_at + shift, s.ingested_at + shift, s.pack_key, s.location, s.item_code
    FROM app.inventory_snapshots s
    LEFT JOIN app.inventory_items oi ON oi.workspace_id = s.workspace_id AND oi.id = s.item_id
    LEFT JOIN app.inventory_items ni ON ni.workspace_id = ws AND ni.pack_key = oi.pack_key
   WHERE s.workspace_id = tpl AND s.pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  INSERT INTO app.workflow_rules (workspace_id, name, trigger_event, condition, action, enabled, pack_key)
  SELECT ws, name, trigger_event, condition, action, enabled, pack_key
    FROM app.workflow_rules WHERE workspace_id = tpl AND pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  UPDATE app.workspaces SET seed_clock_shift = shift WHERE id = ws;
  RETURN total;
END $$;

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
  DELETE FROM app.outbox WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
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
  DELETE FROM app.workflow_rules WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.cases WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.assignees WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.customers WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.demo_sessions WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.workspaces WHERE id = ws;
  INSERT INTO app.retention_log (workspace_id, audit_rows, business_rows) VALUES (ws, a, b);
  RETURN a + b;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
