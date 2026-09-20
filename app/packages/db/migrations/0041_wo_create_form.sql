-- 0041 · The manual create form is configuration, not code.
--
-- One setting per field definition says whether it appears on "Add work
-- order", and whether it may be left empty:
--
--   off       not on the form at all (the default for the 100-odd fields that
--             are filled later in the job's life: QC, invoicing, ratings…)
--   optional  on the form, may be left empty
--   required  on the form, and Create refuses while it is empty
--
-- Admin › Custom fields draws this as one control per field, so adding a
-- field to intake never needs a deploy. WO # is NOT a field_def — it is
-- task.wo_number, NOT NULL UNIQUE by schema — so it is always on the form and
-- always required; the UI draws it as a locked row.
--
-- The seed truncates field_def and rebuilds it from clickup-data.json, so the
-- defaults below are re-applied there as well (seed.ts, "create form" block) —
-- if you change this list, change that one.
--
-- Rule 11.1.1 (the 13 fields a work order needs before it can be ASSIGNED or
-- ACCEPTED) is a separate, stricter gate that still lives in code
-- (packages/shared/src/intakeGate.ts). Creation is deliberately lighter than
-- assignment: a coordinator can raise a work order from a phone call with the
-- number alone, and it cannot reach a dispatcher until the rest is in.

ALTER TABLE field_def
  ADD COLUMN IF NOT EXISTS create_mode text NOT NULL DEFAULT 'off';

ALTER TABLE field_def
  DROP CONSTRAINT IF EXISTS field_def_create_mode_check;

ALTER TABLE field_def
  ADD CONSTRAINT field_def_create_mode_check
  CHECK (create_mode IN ('off', 'optional', 'required'));

-- The starting form: identity, where, what, when, money and people. Every key
-- here exists in the seeded catalogue; a key that does not match simply
-- updates nothing.
UPDATE field_def SET create_mode = 'optional'
 WHERE create_mode = 'off'
   AND key IN (
     'Client Portal Type',
     'Client',
     'Store',
     '17. Address',
     'City',
     'State',
     'Zip Code',
     'Trade',
     'Problem Type',
     '35. WO Description',
     'Date-Time Received',
     'Due Date',
     'SLA Due Date',
     '16. Client NTE 🔴',
     '22. FM',
     '21. Comp',
     'AM',
     'Assignee'
   );
