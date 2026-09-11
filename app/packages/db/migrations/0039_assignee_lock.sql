-- ============================================================================
-- 0039 · Rule 8.5.4 — the reassignment lock
--
-- "IF User_Role IN (SOM, OM, OM Under Probation), THEN disable the ability to
--  change the Assignee field on any Work Order. IF a ticket needs to be
--  transferred, THEN a user with Manager (or higher) role MUST execute the
--  reassignment."
--
-- The Assignee seat is the bag field `Assignee` (People section), and since
-- 0015 what a person may do with one field is a path in the role's
-- permission tree — so the lock is one permission, not code: the three
-- dispatcher tiers (the request-mode roles of 0031, "Only theirs" in 0032)
-- go view-only on `work_orders/fields/people/fields.Assignee`. The API's
-- assertFieldWrites refuses their writes (single edit, bulk edit, import),
-- the field editor draws it read-only, and Accept & assign (0036) stays a
-- manager's act. Only where the path is not already set, so a Roles-screen
-- decision survives; Admin › Roles or a per-user Adjust can loosen it later.
--
-- Role rows are migration-owned (seed.ts never truncates `role`), so nothing
-- here needs mirroring in the seed.
-- ============================================================================

UPDATE role
   SET permissions = permissions
     || jsonb_build_object('work_orders/fields/people/fields.Assignee', jsonb_build_object('edit', false))
 WHERE code IN ('om', 'om_probation', 'senior_om')
   AND NOT (permissions ? 'work_orders/fields/people/fields.Assignee');
