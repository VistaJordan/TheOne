-- 0033 · (0027 on Primary-Updates) Define 'Client Portal Type' — which client CMMS the work order came
-- from (rule 2.6.1's Client_Portal_Type). A dropdown seeded with Ecotrak,
-- Corrigo and ServiceChannel; more portals are added from Admin › Custom
-- fields, and an integration that pulls a work order stamps its own name in
-- the bag. Sits in the Integrations section beside Ecotrak ID.
--
-- field_def rows are seed-owned (see 0011's data note), so seed.ts declares
-- the same row; this INSERT is for an already-seeded database. KEEP IN STEP.
INSERT INTO field_def (container_id, key, label, type, type_config, position)
SELECT c.id,
       'Client Portal Type',
       'Client Portal Type',
       'dropdown',
       '{"options":["Ecotrak","Corrigo","ServiceChannel"]}'::jsonb,
       (SELECT COALESCE(max(position), 0) + 1 FROM field_def WHERE container_id = c.id)
  FROM container c
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;
