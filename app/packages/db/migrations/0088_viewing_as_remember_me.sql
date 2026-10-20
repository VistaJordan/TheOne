-- Three requests from Jordan, 2026-10-20.
--
--   1 · Viewing as can make changes, and the audit log says so.
--       activity_log.viewing_as_id names the person a super admin was viewing
--       as when they acted; actor_principal_id stays the person who acted.
--       The API runs every request made while viewing as inside an audit
--       context (packages/db/src/client.ts runWithAuditContext) whose
--       transactions set two transaction-local settings; the BEFORE INSERT
--       trigger below reads them. A row signed by the viewed person is
--       re-signed by the real one with viewing_as_id set; a row the real
--       person signed already only gains viewing_as_id; a row signed by
--       anyone else (a service principal, an automation) is left alone. No
--       setting = no change, so every request that is not viewing as, the
--       worker and the seed write exactly what they wrote before.
--       No ON DELETE action on the foreign key, like actor_principal_id:
--       activity_log is append-only (0029), so SET NULL could never run.
--
--   2 · "Keep me signed in". session.remember marks a session started with
--       the box ticked: it lasts REMEMBER_ME_DAYS (30 by default) and is
--       pushed out again as it is used (services/auth.ts loadSession).
--       auth_transaction.remember carries the tick across the Microsoft
--       round trip.
--
--   3 · OM Under Probation and Ops Coordinator are one position. The
--       om_probation role stays, with the grants it holds today (it is the
--       sign-in auto-enrol role); everyone in ops_coord moves to it, the
--       role-code lists on dashboards and approval tiers follow, and the
--       ops_coord role is removed. The UAT test account for ops_coord, if
--       one was ever created, is disabled: its username is no longer a role.
--       Role is not truncated by the seed and the seed names no ops_coord
--       principal, so there is nothing for seed.ts to keep in step.

-- ── 1 · viewing as ─────────────────────────────────────────────────────────

ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS viewing_as_id uuid REFERENCES principal(id);

CREATE OR REPLACE FUNCTION activity_log_viewing_as() RETURNS trigger AS $$
DECLARE
  real_id text := NULLIF(current_setting('theone.real_actor_id', true), '');
  view_id text := NULLIF(current_setting('theone.viewing_as_id', true), '');
BEGIN
  IF real_id IS NULL OR view_id IS NULL OR real_id = view_id THEN
    RETURN NEW;
  END IF;
  IF NEW.actor_principal_id::text = view_id THEN
    NEW.actor_principal_id := real_id::uuid;
    NEW.viewing_as_id := view_id::uuid;
  ELSIF NEW.actor_principal_id::text = real_id AND NEW.viewing_as_id IS NULL THEN
    NEW.viewing_as_id := view_id::uuid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS activity_log_viewing_as ON activity_log;
CREATE TRIGGER activity_log_viewing_as
  BEFORE INSERT ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_viewing_as();

-- ── 2 · keep me signed in ──────────────────────────────────────────────────

ALTER TABLE session ADD COLUMN IF NOT EXISTS remember boolean NOT NULL DEFAULT false;
ALTER TABLE auth_transaction ADD COLUMN IF NOT EXISTS remember boolean NOT NULL DEFAULT false;

-- ── 3 · one probation role ─────────────────────────────────────────────────

UPDATE principal
   SET status = 'disabled'
 WHERE role = 'ops_coord' AND lower(email) = 'test+ops_coord@test.theone.local';

UPDATE principal SET role = 'om_probation' WHERE role = 'ops_coord';

-- shared_roles only mirrors the role grants (0050), and om_probation keeps
-- its own, so the stale code is dropped rather than renamed.
UPDATE dashboard
   SET shared_roles = array_remove(shared_roles, 'ops_coord')
 WHERE 'ops_coord' = ANY(shared_roles);

-- These two DECIDE who acts, so the people move with the code.
UPDATE approval_task SET assigned_role = 'om_probation' WHERE assigned_role = 'ops_coord';

UPDATE automation
   SET actions = replace(actions::text, '"assign_role": "ops_coord"', '"assign_role": "om_probation"')::jsonb
 WHERE actions::text LIKE '%"assign_role": "ops_coord"%';

UPDATE approval_tier
   SET roles = ARRAY(SELECT DISTINCT unnest(array_replace(roles, 'ops_coord', 'om_probation')))
 WHERE 'ops_coord' = ANY(roles);

UPDATE role
   SET description = 'Dispatcher on probation (the Ops Coordinator position) — the OM''s work without delete or export.'
 WHERE code = 'om_probation';

DELETE FROM role WHERE code = 'ops_coord';
