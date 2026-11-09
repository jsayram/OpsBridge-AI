-- P7.1 (D-061, D-076): the outbox dispatcher gets a database role of its own.
-- Until now the request role could call claim_due_outbox and finish_outbox, so any request
-- path that ran arbitrary SQL could claim another workspace's event or finish one. finish_outbox
-- already refuses the unsafe outcomes (D-061); this takes both functions away from the request
-- role altogether. The dispatcher reads only rules, only for the workspace it set for one short
-- transaction, and owns no table rights beyond that.
-- infra/db/bootstrap-roles.sql creates the role. Nothing here creates or alters a role.

REVOKE EXECUTE ON FUNCTION app.claim_due_outbox(int, uuid),
  app.finish_outbox(uuid, uuid, uuid, text, text, text, int, text, jsonb) FROM opsbridge_app;

GRANT USAGE ON SCHEMA app TO opsbridge_dispatcher;
GRANT EXECUTE ON FUNCTION app.claim_due_outbox(int, uuid),
  app.finish_outbox(uuid, uuid, uuid, text, text, text, int, text, jsonb) TO opsbridge_dispatcher;

GRANT SELECT ON app.workflow_rules TO opsbridge_dispatcher;
-- Own workspace only: no template rows, and nothing at all when no workspace is set.
CREATE POLICY workflow_rules_dispatch_read ON app.workflow_rules FOR SELECT TO opsbridge_dispatcher
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
