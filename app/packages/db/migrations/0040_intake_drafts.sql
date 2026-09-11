-- ============================================================================
-- 0040 · Section 14 — Incoming Work Order Intake (OP Admin)
--
-- 14.1.1 "a staging area separate from the main global Work Order table":
-- a draft is a row HERE, not a `task` row, until it is submitted with every
-- 11.1.1 field filled and an assignee (14.3.2). Submitting writes the task
-- (services/intake.ts, the same INSERT the CSV import uses), fills the
-- Assignee seat through the ordinary field write, and stamps the draft with
-- the work order it became — the row stays for the trail (rule 1.2.1:
-- intake_draft_created|updated|submitted|discarded in activity_log, entity
-- 'intake_draft', whole snapshots like the admin entities).
--
-- `fields` is the bag the work order will carry, keyed like task.fields
-- ('17. Address', '22. FM', '16. Client NTE 🔴', …), so the same catalogue
-- and the same 11.1.1 check (intakeMissing) apply before and after.
--
-- Discarding is an UPDATE (`discarded_at`), never a DELETE (rule 8.1.1).
--
-- Access (14.1.2) is the permission path `intake` (view / create / edit):
-- Operations Admin (`oa` — the BRD's OP Admin: "intake into the system")
-- and Admin get it here; super admins have everything; every other role is
-- unset, which resolves to no access. Only where the path is not already
-- set, so a Roles-screen decision survives. Role rows are migration-owned.
-- ============================================================================

CREATE TABLE IF NOT EXISTS wo_intake_draft (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_number          text,
  fields             jsonb NOT NULL DEFAULT '{}'::jsonb,
  assignee           text,
  created_by         uuid REFERENCES principal(id) ON DELETE SET NULL,
  updated_by         uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  submitted_at       timestamptz,
  submitted_task_id  uuid REFERENCES task(id) ON DELETE SET NULL,
  discarded_at       timestamptz
);

-- The staging list: open drafts, most recently touched first.
CREATE INDEX IF NOT EXISTS wo_intake_draft_open_idx
  ON wo_intake_draft (updated_at DESC)
  WHERE submitted_at IS NULL AND discarded_at IS NULL;

UPDATE role
   SET permissions = permissions
     || jsonb_build_object('intake', jsonb_build_object('view', true, 'create', true, 'edit', true))
 WHERE code IN ('oa', 'admin')
   AND NOT (permissions ? 'intake');
