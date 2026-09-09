-- ============================================================================
-- 0031 (0025 on Primary-Updates) · Status change requests (rules 2.4.1 – 2.4.4)
--
-- Rule 2.4.1: a Dispatcher cannot move a work order's status; the attempt
--             becomes a Status_Change_Request a manager decides.
-- Rule 2.4.2: the request shows in the manager's inbox (/approvals, section
--             "Status changes").
-- Rule 2.4.3: accept moves the status; reject needs a reason; the dispatcher
--             is told either way and acknowledges the decision.
-- Rule 2.4.4: a pending request pauses nothing (no code — nothing in the app
--             pauses a timer, and the quote clock keys off visit stamps).
--
-- A request is an approval_task (0020) of type 'status_change' — the row
-- already carries who asked, who decided, when, and the decision note that
-- holds the rejection reason. Two columns are added so a decided request can
-- wait in the requester's "My requests" until they say they saw it.
--
-- "Dispatcher" is a PERMISSION, not a role name:
--   work_orders/status  edit   = may change the status directly
--                       create = may REQUEST a change
-- A person with create but not edit is a dispatcher for 2.4.1. The Roles
-- screen and the per-user Adjust draw the pair as one three-way choice.
-- Defaults below (Elise, 2026-09-09): OM, OM Under Probation and Senior OM
-- must request; TL, ATL, Account Manager and Admin change directly and decide.
-- Ops Coordinator and VR Officer are left as they are (inherit work_orders
-- edit) — a one-click switch in Admin › Roles later.
--
-- The inbox's sections become permission paths under `approvals` (view /
-- approve each; unset inherits from `approvals`), so a role — or one person —
-- can see some sections and not others.
--
-- Role rows are migration-owned (seed.ts never truncates `role`), so nothing
-- here needs mirroring in the seed.
-- ============================================================================

ALTER TABLE approval_task
  ADD COLUMN IF NOT EXISTS acknowledged_by uuid REFERENCES principal(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;

-- The requester's inbox reads "my decided, unacknowledged tasks".
CREATE INDEX IF NOT EXISTS approval_task_ack_idx
  ON approval_task (created_by, status)
  WHERE acknowledged_at IS NULL;

-- ── Status-change mode per role ─────────────────────────────────────────────
-- Only where the path is not already set, so a Roles-screen decision survives.
UPDATE role
   SET permissions = permissions
     || jsonb_build_object('work_orders/status', jsonb_build_object('edit', false, 'create', true))
 WHERE code IN ('om', 'om_probation', 'senior_om')
   AND NOT (permissions ? 'work_orders/status');

UPDATE role
   SET permissions = permissions
     || jsonb_build_object('work_orders/status', jsonb_build_object('edit', true, 'create', true))
 WHERE code IN ('tl', 'atl', 'am', 'admin')
   AND NOT (permissions ? 'work_orders/status');

-- ── Approvals sections per role ─────────────────────────────────────────────
-- Approvers decide in the three task sections; everyone else inherits the
-- parent `approvals` grant (view only, from 0020).
UPDATE role
   SET permissions = permissions
     || jsonb_build_object(
          'approvals/nte',     jsonb_build_object('view', true, 'approve', true),
          'approvals/status',  jsonb_build_object('view', true, 'approve', true),
          'approvals/reviews', jsonb_build_object('view', true, 'approve', true))
 WHERE code IN ('tl', 'atl', 'am', 'admin')
   AND NOT (permissions ? 'approvals/status');
