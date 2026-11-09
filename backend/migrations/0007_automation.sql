-- P4: durable automation. Rules become editable and reusable, the dispatcher gets its lease,
-- attempt history and effects ledger, and an emergency pause stops every dispatch at once.
-- The runtime role still can't UPDATE or DELETE outbox rows directly: every state change goes
-- through the definer functions below, which hold the state machine in docs/design/STATE-MACHINES.md.

-- Rules. A rule is one typed trigger, a bounded condition and an allowlisted action. There is
-- no destination column, no recipient and no code: the destination is server configuration.
ALTER TABLE app.workflow_rules
  ADD COLUMN reused_from uuid,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_by text CHECK (length(updated_by) <= 120),
  ADD CONSTRAINT workflow_rules_condition_shape CHECK (
    jsonb_typeof(condition) = 'object' AND pg_column_size(condition) <= 512),
  ADD FOREIGN KEY (workspace_id, reused_from) REFERENCES app.workflow_rules (workspace_id, id);
-- JOB-TEST-06: a rule can be reused for another team once. A second copy for the same team is a
-- duplicate effect waiting to happen.
CREATE UNIQUE INDEX workflow_rules_one_reuse_per_team
  ON app.workflow_rules (workspace_id, reused_from, (condition->>'queue'))
  WHERE reused_from IS NOT NULL;

-- Lease fencing. A finish must present the token its claim got, so a worker whose lease expired
-- and was reclaimed can't overwrite the newer attempt's result.
ALTER TABLE app.outbox
  ADD COLUMN lease_token uuid,
  ADD COLUMN last_error_code text CHECK (last_error_code ~ '^[a-z0-9_]{1,60}$'),
  ADD COLUMN effects jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(effects) = 'array' AND pg_column_size(effects) <= 2048),
  ADD COLUMN finished_at timestamptz,
  ADD CONSTRAINT outbox_lease_shape CHECK (
    (dispatch_state = 'processing') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL));
CREATE INDEX outbox_workspace_created ON app.outbox (workspace_id, created_at DESC, id DESC);

-- One row per dispatch attempt, written only by finish_outbox and claim_due_outbox.
CREATE TABLE app.outbox_attempts (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL,
  attempt int NOT NULL CHECK (attempt BETWEEN 1 AND 6),
  outcome text NOT NULL CHECK (outcome IN
    ('accepted','simulated','retry_scheduled','dead_letter','lease_expired')),
  code text CHECK (code ~ '^[a-z0-9_]{1,60}$'),
  evidence_ref text CHECK (length(evidence_ref) <= 200),
  sink text CHECK (sink IN ('simulated','sheet_bridge')),
  next_attempt_at timestamptz,
  finished_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, outbox_id) REFERENCES app.outbox (workspace_id, id)
);
CREATE INDEX outbox_attempts_event ON app.outbox_attempts (workspace_id, outbox_id, finished_at);

-- The effects ledger. One row per event and rule, whatever the number of attempts: this is the
-- consequential action, and the primary key is what makes a replay a no-op.
CREATE TABLE app.automation_effects (
  workspace_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  rule_version int NOT NULL CHECK (rule_version >= 1),
  action text NOT NULL CHECK (action IN ('sheet_append','simulated_notice')),
  sink text NOT NULL CHECK (sink IN ('simulated','sheet_bridge')),
  evidence_ref text CHECK (length(evidence_ref) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, outbox_id, rule_id),
  FOREIGN KEY (workspace_id, outbox_id) REFERENCES app.outbox (workspace_id, id),
  FOREIGN KEY (workspace_id, rule_id) REFERENCES app.workflow_rules (workspace_id, id)
);

-- Emergency stop for every dispatch, demo and owner. One row, like demo_limits. Pausing leaves
-- events Queued: nothing is dropped, and resuming picks them up.
CREATE TABLE app.automation_control (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  dispatch_paused boolean NOT NULL DEFAULT false,
  reason text CHECK (length(reason) <= 300),
  changed_by text CHECK (length(changed_by) <= 120),
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app.automation_control DEFAULT VALUES;

ALTER TABLE app.outbox_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.automation_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.automation_control ENABLE ROW LEVEL SECURITY;
CREATE POLICY outbox_attempts_read ON app.outbox_attempts FOR SELECT TO opsbridge_app
  USING (workspace_id = app.current_workspace());
CREATE POLICY automation_effects_read ON app.automation_effects FOR SELECT TO opsbridge_app
  USING (workspace_id = app.current_workspace());
CREATE POLICY automation_control_read ON app.automation_control FOR SELECT TO opsbridge_app
  USING (true);

GRANT SELECT ON app.outbox_attempts, app.automation_effects, app.automation_control
  TO opsbridge_app;
-- Rules are now edited (enable, condition, version) and reused (insert) by the request path.
GRANT INSERT, UPDATE ON app.workflow_rules TO opsbridge_app;

-- Workspace mode of the request's own workspace, for the owner-only functions below.
CREATE FUNCTION app.current_mode() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS
  $$ SELECT mode FROM app.workspaces WHERE id = app.current_workspace() $$;

-- Claims up to max_rows due events, demo and owner, never template rows and never an expired
-- demo workspace. A processing row whose lease ran out is history: it gets a lease_expired
-- attempt, and at the cap of 6 it goes to Dead Letter instead of being claimed again.
CREATE FUNCTION app.claim_due_outbox(max_rows int, only_workspace uuid DEFAULT NULL)
RETURNS TABLE (workspace_id uuid, id uuid, payload jsonb, attempts int, lease_token uuid,
               workspace_mode text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
#variable_conflict use_column
DECLARE r record; token uuid;
BEGIN
  IF max_rows < 1 OR max_rows > 10 THEN
    RAISE EXCEPTION 'max_rows out of range' USING ERRCODE = 'P0002';
  END IF;
  IF (SELECT dispatch_paused FROM app.automation_control) THEN RETURN; END IF;
  FOR r IN
    SELECT o.workspace_id, o.id, o.payload, o.dispatch_state, o.attempts, w.mode
      FROM app.outbox o JOIN app.workspaces w ON w.id = o.workspace_id
     WHERE w.mode <> 'template'
       AND (w.mode = 'owner' OR w.expires_at > now())
       AND (only_workspace IS NULL OR o.workspace_id = only_workspace)
       AND ((o.dispatch_state IN ('pending','retry_scheduled') AND o.next_attempt_at <= now())
         OR (o.dispatch_state = 'processing' AND o.lease_expires_at <= now()))
     ORDER BY o.next_attempt_at, o.id
     LIMIT max_rows
       FOR UPDATE OF o SKIP LOCKED
  LOOP
    IF r.dispatch_state = 'processing' THEN
      INSERT INTO app.outbox_attempts (workspace_id, outbox_id, attempt, outcome, code)
      VALUES (r.workspace_id, r.id, r.attempts, 'lease_expired', 'lease_expired');
      IF r.attempts >= 6 THEN
        UPDATE app.outbox o SET dispatch_state = 'dead_letter', lease_token = NULL,
               lease_expires_at = NULL, last_error_code = 'lease_expired', finished_at = now()
         WHERE o.workspace_id = r.workspace_id AND o.id = r.id;
        CONTINUE;
      END IF;
    END IF;
    token := gen_random_uuid();
    UPDATE app.outbox o SET dispatch_state = 'processing', attempts = o.attempts + 1,
           lease_token = token, lease_expires_at = now() + interval '130 seconds'
     WHERE o.workspace_id = r.workspace_id AND o.id = r.id;
    workspace_id := r.workspace_id; id := r.id; payload := r.payload;
    attempts := r.attempts + 1; lease_token := token; workspace_mode := r.mode;
    RETURN NEXT;
  END LOOP;
END $$;

-- Records one attempt's result. Returns the new dispatch_state, or 'stale' when the caller no
-- longer holds the lease, in which case nothing changes. Backoff: 120 s doubling to 1 h, with
-- jitter, never under 120 s and never under a provider's Retry-After.
CREATE FUNCTION app.finish_outbox(ws uuid, event uuid, token uuid, outcome text,
  evidence text, code text, retry_after_seconds int, sink text, effects jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE o record; next_state text; due timestamptz; e jsonb; wait numeric;
BEGIN
  IF outcome NOT IN ('accepted','simulated','retryable','permanent') THEN
    RAISE EXCEPTION 'unknown outcome' USING ERRCODE = 'P0002';
  END IF;
  IF outcome = 'accepted' AND evidence IS NULL THEN
    RAISE EXCEPTION 'accepted needs evidence' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO o FROM app.outbox x WHERE x.workspace_id = ws AND x.id = event FOR UPDATE;
  IF NOT FOUND OR o.dispatch_state <> 'processing' OR o.lease_token IS DISTINCT FROM token THEN
    RETURN 'stale';
  END IF;
  IF outcome IN ('accepted','simulated') THEN
    -- Effects first, idempotently: a replayed event finds its rows and adds none.
    FOR e IN SELECT * FROM jsonb_array_elements(coalesce(effects, '[]'::jsonb)) LOOP
      INSERT INTO app.automation_effects (workspace_id, outbox_id, rule_id, rule_version, action,
                                          sink, evidence_ref)
      VALUES (ws, event, (e->>'ruleId')::uuid, (e->>'ruleVersion')::int, e->>'action',
              coalesce(e->>'sink', finish_outbox.sink), evidence)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
  IF outcome = 'accepted' THEN
    next_state := 'accepted';
  ELSIF outcome = 'simulated' THEN
    next_state := 'simulated';
  ELSIF outcome = 'permanent' OR o.attempts >= 6 THEN
    next_state := 'dead_letter';
  ELSE
    next_state := 'retry_scheduled';
    wait := least(3600, 120 * power(2, o.attempts - 1)) * (0.8 + random() * 0.4);
    wait := greatest(120, wait, coalesce(retry_after_seconds, 0));
    due := now() + make_interval(secs => least(wait, 3600));
  END IF;
  UPDATE app.outbox x SET
    dispatch_state = next_state,
    delivery_evidence = CASE WHEN next_state = 'accepted' THEN 'provider_accepted'
                             ELSE x.delivery_evidence END,
    evidence_ref = CASE WHEN next_state IN ('accepted','simulated') THEN evidence
                        ELSE x.evidence_ref END,
    effects = CASE WHEN next_state IN ('accepted','simulated')
                   THEN coalesce(finish_outbox.effects, '[]'::jsonb) ELSE x.effects END,
    last_error_code = CASE WHEN next_state IN ('retry_scheduled','dead_letter') THEN code END,
    next_attempt_at = coalesce(due, x.next_attempt_at),
    lease_token = NULL, lease_expires_at = NULL,
    finished_at = CASE WHEN next_state = 'retry_scheduled' THEN NULL ELSE now() END
   WHERE x.workspace_id = ws AND x.id = event;
  INSERT INTO app.outbox_attempts (workspace_id, outbox_id, attempt, outcome, code, evidence_ref,
                                   sink, next_attempt_at)
  VALUES (ws, event, o.attempts, next_state, code, evidence, finish_outbox.sink, due);
  RETURN next_state;
END $$;

-- Owner only, on the owner's own workspace: Dead Letter -> Pending. Attempts restart at 0 and
-- the earlier ones stay in outbox_attempts. The caller audits in the same transaction.
CREATE FUNCTION app.retry_dead_letter(event uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
BEGIN
  IF app.current_mode() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'owner workspace only' USING ERRCODE = 'P0002';
  END IF;
  UPDATE app.outbox SET dispatch_state = 'pending', attempts = 0, next_attempt_at = now(),
         last_error_code = NULL, finished_at = NULL
   WHERE workspace_id = app.current_workspace() AND id = event AND dispatch_state = 'dead_letter';
  RETURN FOUND;
END $$;

-- Owner only: Accepted with Provider Accepted -> Confirmed, with the owner's evidence reference.
-- Nothing else can reach Confirmed, so an HTTP 200 never becomes a delivery claim.
CREATE FUNCTION app.confirm_outbox(event uuid, evidence text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
BEGIN
  IF app.current_mode() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'owner workspace only' USING ERRCODE = 'P0002';
  END IF;
  IF evidence IS NULL OR length(evidence) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'evidence required' USING ERRCODE = 'P0002';
  END IF;
  UPDATE app.outbox SET delivery_evidence = 'confirmed', evidence_ref = evidence
   WHERE workspace_id = app.current_workspace() AND id = event
     AND dispatch_state = 'accepted' AND delivery_evidence = 'provider_accepted';
  RETURN FOUND;
END $$;

-- Owner only: the emergency stop. The caller audits in the same transaction.
CREATE FUNCTION app.set_automation_pause(paused boolean, why text, actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
BEGIN
  IF app.current_mode() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'owner workspace only' USING ERRCODE = 'P0002';
  END IF;
  UPDATE app.automation_control SET dispatch_paused = paused, reason = why, changed_by = actor,
         changed_at = now();
END $$;

-- Replaces 0004's purge with the two new tables first, children before the outbox.
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

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_mode(), app.claim_due_outbox(int, uuid),
  app.finish_outbox(uuid, uuid, uuid, text, text, text, int, text, jsonb),
  app.retry_dead_letter(uuid), app.confirm_outbox(uuid, text),
  app.set_automation_pause(boolean, text, text) TO opsbridge_app;
