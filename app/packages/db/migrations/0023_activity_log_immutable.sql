-- ============================================================================
-- 0023 · Activity log immutability (business rule 1.2.2 / 8.1.2)
--
--   "Disable UPDATE and DELETE database commands for the Activity Log table.
--    It is strictly INSERT / Read-only." — and 8.1.2: no user, the super
--    admin included, can change or remove a row.
--
-- Until now this held by convention only (0001: "application never issues
-- UPDATE or DELETE on this table"). Convention does not survive a psql
-- session. A GRANT/REVOKE cannot carry the rule either: PGlite runs as one
-- superuser and the API connects to Neon as the owner, so privileges would
-- never be checked. A trigger is checked for every role, owner and superuser
-- alike, on every path — the API, a console, a migration.
--
-- TRUNCATE is deliberately left alone: row triggers do not fire on it, which
-- is what lets `npm run db:seed` rebuild a LOCAL database. Nothing in the
-- application truncates, and a production database is never seeded.
--
-- To undo (a data-repair migration would have to): DROP TRIGGER
-- activity_log_immutable ON activity_log; do the repair; re-create it — and
-- say why in that migration's header.
-- ============================================================================

CREATE OR REPLACE FUNCTION activity_log_refuse_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'activity_log is append-only: % is not allowed (rule 1.2.2)', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Insert a correcting entry instead of changing history.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS activity_log_immutable ON activity_log;
CREATE TRIGGER activity_log_immutable
  BEFORE UPDATE OR DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_refuse_change();
