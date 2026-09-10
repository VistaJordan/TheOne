-- ============================================================================
-- 0017 · Admin changes land in the audit log too
--
-- Until now activity_log only ever held work-order writes (and sign-in
-- events): creating a custom field, renaming a status, editing a role, inviting
-- a user or changing an automation left no trace. The services behind Admin
-- now write a row for each of those (apps/api/src/services/adminAudit.ts).
--
-- One column has to give: entity_id was `uuid NOT NULL`, and a phase group is
-- keyed by its text CODE (status_group_def.code, 0008), not a uuid. Widening
-- to text keeps every existing row byte-for-byte (a uuid prints as itself) and
-- lets the log point at anything with a stable identifier. Readers that join
-- task.id compare on t.id::text — see auditLog.ts and woMetrics.ts.
--
-- entity_type values after this migration:
--   task · principal · field_def · status · status_group · role · automation
-- ============================================================================

ALTER TABLE activity_log
  ALTER COLUMN entity_id TYPE text USING entity_id::text;
