-- 0037 · Define 'SLA Due Date' — rule 11.1.1's SLA.
--
-- The "Ready to Assign" gate (rules 11.1.1 / 11.1.2, services/intakeGate.ts)
-- refuses to assign a work order until WO#, Received on, Due date, SLA,
-- Address, City, State, Zip code, Store, Trade, WO description, FM, Comp and
-- Client NTE are filled. Every one of those already has a field except the
-- SLA: 'SLA Due Date' was a bag key the header and the Pulse read (the
-- blown-SLA clock) but no field_def declared, so nobody could type it. This
-- makes it an ordinary datetime in the Dates section (packages/shared
-- permissions.ts FIELD_SECTIONS lists it after Due Date).
--
-- field_def rows are seed-owned (see 0011's data note), so seed.ts declares
-- the same row; this INSERT is for an already-seeded database. KEEP IN STEP.
INSERT INTO field_def (container_id, key, label, type, position)
SELECT c.id,
       'SLA Due Date',
       'SLA Due Date',
       'datetime',
       (SELECT COALESCE(max(position), 0) + 1 FROM field_def WHERE container_id = c.id)
  FROM container c
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;
