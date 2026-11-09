-- P5: AI-assisted document review (PRD 10, docs/design/STATE-MACHINES.md "AI review").
-- DEC-003 (fixtures only): fixture PDFs are extracted at build time and their text ships here as
-- page-numbered segments. The Worker never parses a PDF and no object storage exists.

-- Shared, read-only fixture library. No workspace column: these are the same 40 fictional
-- documents for everyone, written only by the migrator at seed time.
CREATE TABLE app.fixture_documents (
  fixture_id text PRIMARY KEY CHECK (fixture_id ~ '^fx-[a-z0-9-]{1,40}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  category text NOT NULL CHECK (category IN ('standard','messy','adversarial')),
  kind text NOT NULL CHECK (kind ~ '^[a-z-]{1,40}$'),
  sha256 bytea NOT NULL UNIQUE CHECK (octet_length(sha256) = 32),
  size int NOT NULL CHECK (size > 0 AND size <= 1048576),
  pages int NOT NULL CHECK (pages BETWEEN 1 AND 20),
  text_layer boolean NOT NULL,
  -- [{id, page, text}], bounded so a review request is bounded too.
  segments jsonb NOT NULL CHECK (jsonb_typeof(segments) = 'array'
    AND jsonb_array_length(segments) <= 200 AND octet_length(segments::text) <= 32768)
);

-- Deterministic fixture answers, keyed by the input hash and prompt version (P5.2). The raw
-- text is stored exactly as a provider would return it, so it goes through the same validation.
CREATE TABLE app.fixture_review_outputs (
  input_sha256 bytea NOT NULL CHECK (octet_length(input_sha256) = 32),
  prompt_version text NOT NULL CHECK (prompt_version ~ '^[a-z0-9.-]{1,40}$'),
  model_version text NOT NULL CHECK (length(model_version) BETWEEN 1 AND 80),
  raw_output text NOT NULL CHECK (length(raw_output) <= 16384),
  PRIMARY KEY (input_sha256, prompt_version)
);

ALTER TABLE app.fixture_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.fixture_review_outputs ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_documents_read ON app.fixture_documents FOR SELECT TO opsbridge_app
  USING (true);
CREATE POLICY fixture_review_outputs_read ON app.fixture_review_outputs FOR SELECT TO opsbridge_app
  USING (true);
GRANT SELECT ON app.fixture_documents, app.fixture_review_outputs TO opsbridge_app;

-- A fixture document row must name a fixture that exists.
ALTER TABLE app.documents
  ADD CONSTRAINT documents_fixture_fk FOREIGN KEY (fixture_id)
    REFERENCES app.fixture_documents (fixture_id) NOT VALID;

-- The one pre-P5 placeholder suggestion (template and its per-session copies) had no input hash
-- and an older shape. Nothing could decide it, since no decision command existed. It is replaced
-- by the seed with a real stored fixture result.
DELETE FROM app.ai_reviews WHERE model_version = 'fixture' AND prompt_version = 'fixture-1';

ALTER TABLE app.ai_reviews
  ADD COLUMN version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD COLUMN mode text NOT NULL DEFAULT 'fixture' CHECK (mode IN ('fixture','live')),
  ADD COLUMN input_sha256 bytea CHECK (octet_length(input_sha256) = 32),
  -- Codes only: which checks ran and what failed. Never provider text.
  ADD COLUMN validation jsonb,
  ADD COLUMN error_code text CHECK (error_code ~ '^[a-z0-9_]{1,60}$'),
  ADD COLUMN attempts int NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  ADD COLUMN latency_ms int CHECK (latency_ms >= 0),
  ADD COLUMN tokens_in int NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  ADD COLUMN tokens_out int NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  ADD COLUMN requested_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN decided_by text CHECK (length(decided_by) <= 200),
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decision_reason text CHECK (length(decision_reason) <= 500),
  -- Checklist changes a reviewer committed through the ordinary command, for the audit trail.
  ADD COLUMN applied jsonb,
  ADD CONSTRAINT ai_reviews_output_shape CHECK (
    status NOT IN ('Needs Human Review','Accepted','Accepted with Edits','Rejected')
    OR (extraction IS NOT NULL AND citations IS NOT NULL AND input_sha256 IS NOT NULL)),
  ADD CONSTRAINT ai_reviews_decided CHECK (
    (status IN ('Accepted','Accepted with Edits','Rejected')) = (decided_at IS NOT NULL)),
  ADD CONSTRAINT ai_reviews_edits_only_with_edits CHECK (
    reviewer_edits IS NULL OR status = 'Accepted with Edits');
CREATE INDEX ai_reviews_document ON app.ai_reviews (workspace_id, document_id, requested_at DESC);
CREATE INDEX ai_reviews_processing ON app.ai_reviews (processing_started_at)
  WHERE status = 'Processing';

-- PRD 10 data model: the original suggestion is immutable once stored, for every role. Reviewer
-- edits live beside it. A decided review is final. Purge deletes rows; nothing rewrites them.
CREATE FUNCTION app.ai_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.extraction IS NOT NULL AND (
       NEW.extraction IS DISTINCT FROM OLD.extraction
    OR NEW.citations IS DISTINCT FROM OLD.citations
    OR NEW.model_version IS DISTINCT FROM OLD.model_version
    OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
    OR NEW.input_sha256 IS DISTINCT FROM OLD.input_sha256
    OR NEW.document_id IS DISTINCT FROM OLD.document_id) THEN
    RAISE EXCEPTION 'ai_suggestion_immutable' USING ERRCODE = 'P0010';
  END IF;
  -- What the reviewer is looking at can't shift under them while the review waits.
  IF OLD.status = 'Needs Human Review' AND (NEW.mode IS DISTINCT FROM OLD.mode
       OR NEW.validation IS DISTINCT FROM OLD.validation
       OR NEW.abstain_reason IS DISTINCT FROM OLD.abstain_reason) THEN
    RAISE EXCEPTION 'ai_suggestion_immutable' USING ERRCODE = 'P0010';
  END IF;
  IF OLD.status IN ('Accepted','Accepted with Edits','Rejected') THEN
    RAISE EXCEPTION 'ai_review_decided' USING ERRCODE = 'P0011';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_review_guard BEFORE UPDATE ON app.ai_reviews
  FOR EACH ROW EXECUTE FUNCTION app.ai_review_guard();

-- Review and live-model usage per workspace and UTC day (P5.3). Every request reserves here
-- under a row lock, before any call, so limits hold across concurrent requests.
CREATE TABLE app.ai_usage (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  day date NOT NULL,
  -- Every review requested, fixture or live, for the daily quota. Locked before each one.
  reviews int NOT NULL DEFAULT 0 CHECK (reviews >= 0),
  -- Live provider calls only.
  requests int NOT NULL DEFAULT 0 CHECK (requests >= 0),
  tokens_in int NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out int NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  -- Estimated, in millionths of a US dollar, from a fixed price table in code.
  cost_micro_usd bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  PRIMARY KEY (workspace_id, day)
);
ALTER TABLE app.ai_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_usage_read ON app.ai_usage FOR SELECT TO opsbridge_app
  USING (workspace_id = app.current_workspace());
CREATE POLICY ai_usage_ins ON app.ai_usage FOR INSERT TO opsbridge_app
  WITH CHECK (workspace_id = app.writable_workspace());
CREATE POLICY ai_usage_upd ON app.ai_usage FOR UPDATE TO opsbridge_app
  USING (workspace_id = app.writable_workspace())
  WITH CHECK (workspace_id = app.writable_workspace());

-- D-028 said documents and AI reviews stay read-only until the phase that writes them.
GRANT INSERT ON app.documents TO opsbridge_app;
GRANT INSERT, UPDATE ON app.ai_reviews TO opsbridge_app;
GRANT SELECT, INSERT, UPDATE ON app.ai_usage TO opsbridge_app;

-- Replaces 0004's copy: documents now carry their hash, size and type, and reviews their mode,
-- input hash and validation codes.
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

  INSERT INTO app.documents (workspace_id, case_id, title, fixture_id, category, status, pack_key,
                             sha256, size, verified_type)
  SELECT ws, nc.id, d.title, d.fixture_id, d.category, d.status, d.pack_key,
         d.sha256, d.size, d.verified_type
    FROM app.documents d
    JOIN app.cases oc ON oc.workspace_id = d.workspace_id AND oc.id = d.case_id
    JOIN app.cases nc ON nc.workspace_id = ws AND nc.pack_key = oc.pack_key
   WHERE d.workspace_id = tpl AND d.pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  INSERT INTO app.ai_reviews (workspace_id, document_id, model_version, prompt_version,
                              extraction, citations, status, abstain_reason, mode, input_sha256,
                              validation)
  SELECT ws, nd.id, r.model_version, r.prompt_version, r.extraction, r.citations, r.status,
         r.abstain_reason, r.mode, r.input_sha256, r.validation
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


-- Replaces 0007's copy: AI usage rows go with the workspace.
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


REVOKE ALL ON FUNCTION app.ai_review_guard() FROM PUBLIC;

-- PRD 7.2: the sweep fails any review left in Processing for more than 5 minutes, for example
-- after a Worker was stopped between its two transactions. Bounded per run. Cleanup role only.
CREATE FUNCTION app.fail_stuck_ai_reviews(max_rows int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE n int := 0; r record;
BEGIN
  FOR r IN
    SELECT a.workspace_id, a.id, d.case_id FROM app.ai_reviews a
      JOIN app.documents d ON d.workspace_id = a.workspace_id AND d.id = a.document_id
     WHERE a.status = 'Processing' AND a.processing_started_at < now() - interval '5 minutes'
     ORDER BY a.processing_started_at LIMIT least(max_rows, 100)
     FOR UPDATE OF a SKIP LOCKED
  LOOP
    UPDATE app.ai_reviews SET status = 'Failed', error_code = 'processing_timeout',
           version = version + 1
     WHERE workspace_id = r.workspace_id AND id = r.id;
    -- Visible in the case timeline. A demo workspace at its write cap still gets the status.
    BEGIN
      INSERT INTO app.audit_events (workspace_id, actor_type, actor_id, action, target, summary)
      VALUES (r.workspace_id, 'system', 'sweep', 'ai_review.failed', r.case_id::text,
              'Review timed out in Processing and can be retried');
    EXCEPTION WHEN SQLSTATE 'P0008' THEN NULL;
    END;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.fail_stuck_ai_reviews(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.fail_stuck_ai_reviews(int) TO opsbridge_cleanup;
