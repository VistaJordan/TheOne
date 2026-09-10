-- ============================================================================
-- 0036 · Pending acceptance queue (rules 7.1.1 – 7.1.4)
--
-- Rule 7.1.1: a work order the system creates (the Ecotrak sync, a CSV
--             import) with no assignee is pushed to the manager's Pending
--             Acceptance queue.
-- Rule 7.1.2: Reject asks for a reason and moves the work order to
--             "Cancelled / Postponed".
-- Rule 7.1.3: Accept asks for the assignee (picked by hand — the auto-assign
--             suggester is a later phase).
-- Rule 7.1.4: once assigned, the work order leaves the queue and shows in
--             that dispatcher's own list (the 0032 scope does the showing).
--
-- The queue is an approval_task (0026) of type 'wo_acceptance' — no new
-- table. The work order keeps its ordinary status (Open) while it waits;
-- "pending" = the open task + an empty Assignee (Elise, 2026-09-10).
--
-- The inbox section is the permission path approvals/intake (view /
-- approve; unset inherits from `approvals`). Managers for 7.1 are the same
-- roles that decide status-change requests (0031): TL, ATL, Account Manager
-- and Admin. Only where the path is not already set, so a Roles-screen
-- decision survives a re-run. Role rows are migration-owned (seed.ts never
-- truncates `role`), so nothing here needs mirroring in the seed.
-- ============================================================================

UPDATE role
   SET permissions = permissions
     || jsonb_build_object('approvals/intake', jsonb_build_object('view', true, 'approve', true))
 WHERE code IN ('tl', 'atl', 'am', 'admin')
   AND NOT (permissions ? 'approvals/intake');

-- The inbox and the header chip read "the open acceptance on this work order".
CREATE INDEX IF NOT EXISTS approval_task_open_type_idx
  ON approval_task (task_id, type)
  WHERE status = 'open';
