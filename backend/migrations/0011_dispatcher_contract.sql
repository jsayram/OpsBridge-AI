-- P7.1 (D-076), contract half of 0010. The request role loses claim_due_outbox and
-- finish_outbox, so a request-path SQL mistake can't claim another workspace's event or finish
-- one. A Worker from before 0010 can no longer dispatch once this runs (its events wait, nothing
-- is lost), so on a host this ships in the release after the one that moved dispatch to
-- HYPERDRIVE_DISPATCH: `node scripts/db.mjs migrate --to 0010` first, plain `migrate` next time.
REVOKE EXECUTE ON FUNCTION app.claim_due_outbox(int, uuid),
  app.finish_outbox(uuid, uuid, uuid, text, text, text, int, text, jsonb) FROM opsbridge_app;
