-- 0034 · Rule 2.5.1 — the 'Emergency' flag.
--
-- "IF Is_Emergency == TRUE, THEN apply a visual RED indicator to the WO across
-- ALL views." The flag is one checkbox custom field, `Emergency`, so it gets a
-- list column, a filter, saved views, bulk edit, per-field permissions
-- (work_orders/fields/overview/fields.Emergency) and an audit row on every
-- change for free. The list, the queues and the inbox project it on every row
-- (`emergency` / `wo_emergency`) so the red reads without fetching the bag.
--
-- Today a person ticks it. Later the client portals decide it: Jordan's
-- Ecotrak ingest already maps Ecotrak priority L1 to the core `priority`
-- value 'urgent', and ServiceChannel / Corrigo will do the same, so the
-- automation below ("priority changed to urgent → Emergency = true") is the
-- hook. It ships PAUSED: the ingest does not dispatch automations yet, and
-- the founder wants the manual checkbox alone for now. Switch it on from
-- Admin › Automations when the connectors are wired. Because it fires only
-- when the priority CHANGES, an admin unticking the box sticks until the
-- client changes their priority again (the override rule).
--
-- field_def rows are seed-owned (0011's data note): seed.ts declares the same
-- row in CURATED_FIELDS; this INSERT is for an already-seeded database. The
-- automation table is NOT truncated by the seed, so this is its only home.
-- KEEP THE FIELD IN STEP.
INSERT INTO field_def (container_id, key, label, type, type_config, position)
SELECT c.id,
       'Emergency',
       'Emergency',
       'checkbox',
       '{}'::jsonb,
       (SELECT COALESCE(max(position), 0) + 1 FROM field_def WHERE container_id = c.id)
  FROM container c
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;

INSERT INTO automation (name, enabled, entity, trigger, conditions, actions, position)
SELECT 'Rule 2.5.1 · Emergency from client priority',
       false,
       'work_order',
       '{"kind":"changed","field":"priority","to":"urgent","to_op":"eq","to_field":null,"delay_minutes":null}'::jsonb,
       '{"match":"all","rules":[]}'::jsonb,
       '[{"kind":"set_field","field":"fields.Emergency","value":"true"}]'::jsonb,
       COALESCE((SELECT MAX(position) + 1 FROM automation), 0)
 WHERE NOT EXISTS (
         SELECT 1 FROM automation
          WHERE name = 'Rule 2.5.1 · Emergency from client priority');
