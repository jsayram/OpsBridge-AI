-- P2.1: the rest of the PRD 7 and 7.3 pack tables, the approval and outbox tables, idempotency
-- keys and the workflow columns on cases. Conventions from 0001: composite keys so a child row
-- can't cross a workspace, RLS on, reads through own-or-template, writes through
-- app.writable_workspace(). Grants stay narrower than PRD 7.4 allows: a table gets runtime
-- writes in the phase that writes it (D-028).

-- Fictional consultants. Kept apart from users and memberships, which the runtime role can't
-- touch at all (D-018) and which describe real sign-ins. A demo workspace has no real people.
CREATE TABLE app.assignees (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  team text NOT NULL CHECK (team IN ('Field Services','Seasonal Staffing')),
  can_receive_cases boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  pack_key text,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, pack_key)
);

ALTER TABLE app.cases
  ADD COLUMN queue text NOT NULL DEFAULT 'Field Services'
    CHECK (queue IN ('Field Services','Seasonal Staffing')),
  ADD FOREIGN KEY (workspace_id, assignee_id) REFERENCES app.assignees (workspace_id, id);
-- List order. The status index from 0001 stays for status-filtered pages.
CREATE INDEX cases_workspace_created ON app.cases (workspace_id, created_at DESC, id DESC);

CREATE TABLE app.case_checklist_items (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL,
  item_key text NOT NULL CHECK (item_key ~ '^[a-z0-9_]{1,60}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  position int NOT NULL DEFAULT 0 CHECK (position >= 0),
  required boolean NOT NULL DEFAULT true,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','flagged','done','not_applicable')),
  evidence_ref text CHECK (length(evidence_ref) <= 200),
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, case_id, item_key),
  FOREIGN KEY (workspace_id, case_id) REFERENCES app.cases (workspace_id, id)
);

-- Append-only by grant: the runtime role can insert and read, never change one.
CREATE TABLE app.consultant_handoffs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL,
  from_assignee_id uuid,
  to_assignee_id uuid,
  from_queue text NOT NULL,
  to_queue text NOT NULL,
  due_at timestamptz,
  checklist_version int NOT NULL CHECK (checklist_version >= 0),
  open_required int NOT NULL CHECK (open_required >= 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  actor_type text NOT NULL CHECK (actor_type IN ('demo_session','owner','system')),
  actor_id text NOT NULL,
  expected_case_version int NOT NULL CHECK (expected_case_version >= 1),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, case_id) REFERENCES app.cases (workspace_id, id),
  FOREIGN KEY (workspace_id, from_assignee_id) REFERENCES app.assignees (workspace_id, id),
  FOREIGN KEY (workspace_id, to_assignee_id) REFERENCES app.assignees (workspace_id, id)
);
CREATE INDEX consultant_handoffs_case ON app.consultant_handoffs (workspace_id, case_id, occurred_at);

CREATE TABLE app.approvals (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL,
  proposed_action text NOT NULL CHECK (proposed_action IN ('approve_case')),
  proposed_payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','withdrawn')),
  requested_by text NOT NULL,
  actor_id text,
  decided_at timestamptz,
  reason text CHECK (length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, case_id) REFERENCES app.cases (workspace_id, id),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status <> 'rejected' OR reason IS NOT NULL)
);
-- D-013: one row per entry to Ready, so at most one can be open.
CREATE UNIQUE INDEX approvals_one_pending ON app.approvals (workspace_id, case_id)
  WHERE status = 'pending';

CREATE TABLE app.outbox (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type IN ('case.created','case.needs_review',
    'approval.completed','reconciliation.resolved','integration.degraded')),
  payload_ref text NOT NULL CHECK (length(payload_ref) BETWEEN 1 AND 32),
  payload jsonb NOT NULL CHECK (pg_column_size(payload) <= 2048),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  dispatch_state text NOT NULL DEFAULT 'pending' CHECK (dispatch_state IN
    ('pending','processing','retry_scheduled','accepted','simulated','dead_letter')),
  delivery_evidence text NOT NULL DEFAULT 'none'
    CHECK (delivery_evidence IN ('none','provider_accepted','confirmed')),
  evidence_ref text CHECK (length(evidence_ref) <= 200),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  CHECK (delivery_evidence <> 'confirmed' OR evidence_ref IS NOT NULL)
);
CREATE INDEX outbox_due ON app.outbox (next_attempt_at)
  WHERE dispatch_state IN ('pending','retry_scheduled','processing');

CREATE TABLE app.idempotency_keys (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 64),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  response_status int CHECK (response_status BETWEEN 200 AND 299),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);
CREATE INDEX idempotency_keys_created ON app.idempotency_keys (created_at);

-- Tables below are written by later phases. P2 needs them so the pack is complete and reset
-- is proven on the real shape.
CREATE TABLE app.documents (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  object_key text CHECK (length(object_key) <= 300),
  fixture_id text CHECK (fixture_id ~ '^fx-[a-z0-9-]{1,40}$'),
  category text CHECK (category IN ('standard','messy','adversarial')),
  sha256 bytea CHECK (octet_length(sha256) = 32),
  size int CHECK (size > 0),
  verified_type text CHECK (verified_type IN ('application/pdf')),
  status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Ready','Rejected')),
  pack_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, pack_key),
  FOREIGN KEY (workspace_id, case_id) REFERENCES app.cases (workspace_id, id),
  CHECK ((object_key IS NULL) <> (fixture_id IS NULL)),
  -- Ready means the bytes were checked, so it needs a hash and a type.
  CHECK (status <> 'Ready' OR (sha256 IS NOT NULL AND verified_type IS NOT NULL))
);
CREATE INDEX documents_case ON app.documents (workspace_id, case_id);

CREATE TABLE app.ai_reviews (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  model_version text NOT NULL,
  prompt_version text NOT NULL,
  extraction jsonb,
  citations jsonb,
  reviewer_edits jsonb,
  status text NOT NULL DEFAULT 'Queued' CHECK (status IN ('Queued','Processing',
    'Needs Human Review','Accepted','Accepted with Edits','Rejected','Failed')),
  abstain_reason text CHECK (abstain_reason IN ('no_extractable_text','ambiguous',
    'adversarial_content','missing_required_fields')),
  processing_started_at timestamptz,
  cost_units int NOT NULL DEFAULT 0 CHECK (cost_units >= 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, document_id) REFERENCES app.documents (workspace_id, id)
);

CREATE TABLE app.external_record_links (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('crm_simulator','erp_simulator','inventory_simulator')),
  external_type text NOT NULL CHECK (length(external_type) BETWEEN 1 AND 60),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 120),
  canonical_type text NOT NULL CHECK (canonical_type IN ('customer','inventory_item')),
  canonical_id uuid NOT NULL,
  last_seen timestamptz NOT NULL,
  pack_key text,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, pack_key),
  UNIQUE (workspace_id, provider, external_type, external_id)
);

CREATE TABLE app.customer_source_relationships (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  external_record_link_id uuid NOT NULL,
  relationship_role text NOT NULL CHECK (relationship_role IN ('crm_organization','erp_bill_to')),
  mapping_version text NOT NULL CHECK (length(mapping_version) BETWEEN 1 AND 40),
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, customer_id, external_record_link_id),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES app.customers (workspace_id, id),
  FOREIGN KEY (workspace_id, external_record_link_id)
    REFERENCES app.external_record_links (workspace_id, id)
);

CREATE TABLE app.reconciliation_findings (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('customer','inventory_item')),
  entity_id uuid NOT NULL,
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 32),
  severity text NOT NULL CHECK (severity IN ('low','medium','high')),
  source_values jsonb NOT NULL,
  status text NOT NULL DEFAULT 'Open' CHECK (status IN
    ('Open','Investigating','Proposed','Resolved','Dismissed','Deferred')),
  defer_until timestamptz,
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  resolved_at timestamptz,
  supersedes_id uuid,
  pack_key text,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, pack_key),
  FOREIGN KEY (workspace_id, supersedes_id) REFERENCES app.reconciliation_findings (workspace_id, id),
  CHECK (status <> 'Deferred' OR defer_until IS NOT NULL)
);

CREATE TABLE app.inventory_items (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  canonical_item_code text NOT NULL CHECK (length(canonical_item_code) BETWEEN 1 AND 40),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  canonical_unit text NOT NULL CHECK (canonical_unit IN ('each','box','case','kg','litre')),
  lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('Active','Retired')),
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  pack_key text,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, canonical_item_code),
  UNIQUE (workspace_id, pack_key)
);

CREATE TABLE app.inventory_snapshots (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid,
  unresolved_source_ref text CHECK (length(unresolved_source_ref) <= 120),
  provider text NOT NULL CHECK (provider IN ('inventory_simulator')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 120),
  quantity numeric(14,3) NOT NULL CHECK (quantity >= 0),
  unit text NOT NULL CHECK (length(unit) BETWEEN 1 AND 20),
  source_version int NOT NULL CHECK (source_version >= 1),
  observed_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  pack_key text,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, pack_key),
  UNIQUE (workspace_id, provider, external_id, source_version),
  FOREIGN KEY (workspace_id, item_id) REFERENCES app.inventory_items (workspace_id, id),
  CHECK ((item_id IS NULL) <> (unresolved_source_ref IS NULL))
);

CREATE TABLE app.workflow_rules (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  trigger_event text NOT NULL CHECK (trigger_event IN ('case.created','case.needs_review',
    'approval.completed','reconciliation.resolved','integration.degraded')),
  condition jsonb NOT NULL DEFAULT '{}',
  action text NOT NULL CHECK (action IN ('sheet_append','simulated_notice')),
  enabled boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  pack_key text,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, pack_key)
);

ALTER TABLE app.audit_events
  ADD COLUMN actor_role text CHECK (actor_role IN ('viewer','analyst','manager','owner','system')),
  ADD COLUMN summary text CHECK (length(summary) <= 800);
CREATE INDEX audit_events_target ON app.audit_events (workspace_id, target, id);

-- Every write audits, so one limit here bounds everything a demo session can add. Without it
-- one session could write for its whole two hours at the API rate limit.
ALTER TABLE app.demo_limits ADD COLUMN write_cap int NOT NULL DEFAULT 500 CHECK (write_cap > 0);

CREATE FUNCTION app.audit_write_cap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
BEGIN
  IF (SELECT mode FROM app.workspaces WHERE id = NEW.workspace_id) = 'demo'
     AND (SELECT count(*) FROM app.audit_events WHERE workspace_id = NEW.workspace_id)
         >= (SELECT write_cap FROM app.demo_limits) THEN
    RAISE EXCEPTION 'demo_write_limit' USING ERRCODE = 'P0008';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_write_cap BEFORE INSERT ON app.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_write_cap();

-- RLS. Shared rows read through own-or-template, private ones through own only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assignees','case_checklist_items','consultant_handoffs','approvals',
    'outbox','documents','ai_reviews','external_record_links','customer_source_relationships',
    'reconciliation_findings','inventory_items','inventory_snapshots','workflow_rules'] LOOP
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
END $$;

ALTER TABLE app.idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_read ON app.idempotency_keys FOR SELECT TO opsbridge_app
  USING (workspace_id = app.current_workspace());
CREATE POLICY idempotency_keys_ins ON app.idempotency_keys FOR INSERT TO opsbridge_app
  WITH CHECK (workspace_id = app.writable_workspace());
CREATE POLICY idempotency_keys_upd ON app.idempotency_keys FOR UPDATE TO opsbridge_app
  USING (workspace_id = app.writable_workspace())
  WITH CHECK (workspace_id = app.writable_workspace());

GRANT SELECT, INSERT, UPDATE ON app.case_checklist_items, app.approvals, app.idempotency_keys
  TO opsbridge_app;
-- Handoffs are history. The dispatcher changes outbox rows through P4's functions, not grants.
GRANT SELECT, INSERT ON app.consultant_handoffs, app.outbox TO opsbridge_app;
GRANT SELECT ON app.assignees, app.documents, app.ai_reviews, app.external_record_links,
  app.customer_source_relationships, app.reconciliation_findings, app.inventory_items,
  app.inventory_snapshots, app.workflow_rules TO opsbridge_app;

-- Replaces 0001's copy. One statement per pack table, in dependency order. Every date moves by
-- the recorded clock shift, so "overdue" reads the same on any launch day.
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

  INSERT INTO app.reconciliation_findings (workspace_id, entity_type, entity_id, kind, severity,
                                           source_values, status, pack_key)
  SELECT ws, f.entity_type, nc.id, f.kind, f.severity, f.source_values, f.status, f.pack_key
    FROM app.reconciliation_findings f
    JOIN app.customers oc ON oc.workspace_id = f.workspace_id AND oc.id = f.entity_id
    JOIN app.customers nc ON nc.workspace_id = ws AND nc.pack_key = oc.pack_key
   WHERE f.workspace_id = tpl AND f.pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  INSERT INTO app.inventory_items (workspace_id, canonical_item_code, description, canonical_unit,
                                   lifecycle_status, pack_key)
  SELECT ws, canonical_item_code, description, canonical_unit, lifecycle_status, pack_key
    FROM app.inventory_items WHERE workspace_id = tpl AND pack_key IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  INSERT INTO app.inventory_snapshots (workspace_id, item_id, unresolved_source_ref, provider,
    external_id, quantity, unit, source_version, observed_at, ingested_at, pack_key)
  SELECT ws, ni.id, s.unresolved_source_ref, s.provider, s.external_id, s.quantity, s.unit,
         s.source_version, s.observed_at + shift, s.ingested_at + shift, s.pack_key
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

-- Replaces 0002's purge with every new table, children first.
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
  DELETE FROM app.customer_source_relationships WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.external_record_links WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.workflow_rules WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.cases WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.assignees WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.customers WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.demo_sessions WHERE workspace_id = ws; GET DIAGNOSTICS n = ROW_COUNT; b := b + n;
  DELETE FROM app.workspaces WHERE id = ws;
  INSERT INTO app.retention_log (workspace_id, audit_rows, business_rows) VALUES (ws, a, b);
  RETURN a + b;
END $$;

-- PRD 7: keys are kept 24 hours. Demo keys also go with their workspace.
CREATE FUNCTION app.purge_expired_idempotency_keys() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE n int;
BEGIN
  DELETE FROM app.idempotency_keys WHERE created_at < now() - interval '24 hours';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_idempotency_keys() TO opsbridge_cleanup;
