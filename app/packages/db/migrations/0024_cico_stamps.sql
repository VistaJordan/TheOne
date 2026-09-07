-- 0024 · 'Checked-in At' and 'Checked-out At' datetime fields.
--
-- The operation needs the moment a technician checked in and out as a VALUE
-- on the work order (a dashboard column, an export, a future time-on-site
-- figure), not only as a line in the audit trail. The API stamps these two
-- fields whenever '18. Check-in/out Status' moves (services/cicoStamps.ts);
-- they stay ordinary datetime fields so a wrong stamp can be corrected by hand.
--
-- field_def rows are seed-owned (truncated + rebuilt — see 0007's data note),
-- so seed.ts §4 declares the same two rows; this INSERT exists so an
-- ALREADY-SEEDED database picks them up from `npm run migrate` alone, without
-- a re-seed wiping local edits. KEEP THE TWO IN STEP.
INSERT INTO field_def (container_id, key, label, type, position)
SELECT c.id, v.key, v.label, 'datetime',
       (SELECT max(position) FROM field_def WHERE container_id = c.id) + v.n
  FROM container c
  CROSS JOIN (VALUES ('Checked-in At', 'Checked-in At', 1),
                     ('Checked-out At', 'Checked-out At', 2)) AS v(key, label, n)
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;
