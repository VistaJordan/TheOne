-- 0102 · Elise, 2026-10-27.
--
-- 1. Add work order: the fields Create refuses without. Who the job is for
--    (Comp, Client, FM), where (Store, Address, City, State, Zip Code), what
--    (Trade, WO Description), when it came in (Date-Time Received, which the
--    form now pre-fills with the moment it is opened) and the Client NTE.
--    Due Date and SLA Due Date stay optional (rule 11.1.1 still asks for
--    them before assignment). Configuration as before: Admin › Custom fields
--    › "Add work order" turns any field back to "On the form" or any other
--    to "Required". seed.ts applies the same list through
--    WO_CREATE_REQUIRED_KEYS (packages/shared/src/woCreate.ts) — KEEP IN STEP.
--
-- 2. An approved status-change request no longer waits for the requester's
--    Continue: decide() stamps it acknowledged as it approves (the status has
--    already moved). The approved requests on file that nobody acknowledged
--    yet are stamped here the same way, so they leave My requests and the
--    work-order header chip. Rejections still wait for Understood.

UPDATE field_def
   SET create_mode = 'required'
 WHERE key = ANY (ARRAY[
   '21. Comp',
   'Client',
   '22. FM',
   'Store',
   '17. Address',
   'City',
   'State',
   'Zip Code',
   'Trade',
   '35. WO Description',
   'Date-Time Received',
   '16. Client NTE 🔴'
 ]);

UPDATE approval_task
   SET acknowledged_by = created_by,
       acknowledged_at = COALESCE(decided_at, now())
 WHERE type = 'status_change'
   AND status = 'approved'
   AND acknowledged_at IS NULL;
