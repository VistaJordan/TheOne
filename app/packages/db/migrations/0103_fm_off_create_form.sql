-- 0103 · Elise, 2026-10-27. FM and Client name the same company (the FM list
-- is ClickUp's spelling of the client: "Powerhouse" for PH, "7-Eleven" for
-- 7-11), so Add work order asks only for the Client.
--
-- 1. FM leaves the create form. 0102 had made it required; it is now off.
--    The field stays on every work order (All fields), for the ClickUp sync
--    and the check-in method's FM fallback. Admin › Custom fields can put it
--    back. seed.ts follows through WO_CREATE_DEFAULT_KEYS and
--    WO_CREATE_REQUIRED_KEYS (packages/shared/src/woCreate.ts), which no
--    longer list it — KEEP IN STEP.
--
-- 2. Rule 11.1.1's "Ready to Assign" gate asks for the Client in FM's place
--    (INTAKE_REQUIRED_FIELDS in packages/shared/src/intakeGate.ts). Code only:
--    nothing to change in the database.

UPDATE field_def
   SET create_mode = 'off'
 WHERE key = '22. FM';
