-- 0035 · Define 'Parts Required' — rule 11.2.2's Parts_Required_List.
--
-- Moving a work order to Waiting for Parts or Please Order Parts is refused
-- until this field says which parts are needed (services/statusGates.ts);
-- rule 11.2.1 gates Quote Ready on the quote in the same place and needs no
-- column — the quote tables already exist. A long-text field (one part per
-- line is the convention, nothing parses it) in the Overview section, next
-- to the WO description.
--
-- field_def rows are seed-owned (see 0011's data note), so seed.ts declares
-- the same row; this INSERT is for an already-seeded database. KEEP IN STEP.
INSERT INTO field_def (container_id, key, label, type, position)
SELECT c.id,
       'Parts Required',
       'Parts Required',
       'long_text',
       (SELECT COALESCE(max(position), 0) + 1 FROM field_def WHERE container_id = c.id)
  FROM container c
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;
