-- 0011 · Define 'Completion Assignee' as a `users` field.
--
-- The key has carried values in task.fields since the ClickUp import, but with
-- no field_def behind it the catalogue could not see it: the All-fields tab
-- renders the CATALOGUE, not the bag, so the field was invisible there and
-- read-only on the People card. Typing it `users` also gives it the person
-- picker every other people field has (woFields: users → select, options =
-- every active principal plus any name already on a task).
--
-- field_def rows are seed-owned (truncated + rebuilt — see 0007's data note),
-- so seed.ts §4 declares the same row; this INSERT exists so an ALREADY-SEEDED
-- pgdata picks it up from `npm run migrate` alone, without a re-seed wiping
-- local edits. KEEP THE TWO IN STEP.
INSERT INTO field_def (container_id, key, label, type, position)
SELECT c.id,
       'Completion Assignee',
       'Completion Assignee',
       'users',
       (SELECT max(position) + 1 FROM field_def WHERE container_id = c.id)
  FROM container c
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;
