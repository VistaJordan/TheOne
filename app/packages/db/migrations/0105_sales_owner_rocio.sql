-- 0105 · Elise, 2026-10-28. The Sales column on Clients is a dropdown of the
-- salespeople: Rocio, Teresa, Kevin and House. Its list IS the Sales Owner
-- field's options (Add work order's Sales Owner reads the same list), and a
-- team saved with a new name adds it there (services/clientTeams.ts
-- `addSalesperson`); Admin › Custom fields edits it too.
--
-- 1. ClickUp's "Ro" option becomes "Rocio", the name the account teams use
--    (0096 loaded "Rocio"), in the same place in the list. Work orders that
--    already hold "Ro" keep it: stored values are never rewritten.
-- 2. Teresa, Kevin and House are appended when missing; an admin's own
--    additions stay.
--
-- seed.ts carries the same list in CURATED_FIELDS (SALES_OWNER_DEFAULT_OPTIONS
-- in packages/shared/src/clientTeams.ts) — KEEP IN STEP.

UPDATE field_def f
   SET type_config = jsonb_set(
         COALESCE(f.type_config, '{}'::jsonb),
         '{options}',
         COALESCE((
           SELECT jsonb_agg(CASE WHEN jsonb_typeof(o) = 'string' AND lower(btrim(o #>> '{}')) = 'ro'
                                 THEN to_jsonb('Rocio'::text) ELSE o END ORDER BY i)
             FROM jsonb_array_elements(COALESCE(f.type_config -> 'options', '[]'::jsonb)) WITH ORDINALITY AS e(o, i)
         ), '[]'::jsonb)
       )
 WHERE f.key = 'Sales Owner'
   AND f.type = 'dropdown'
   AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(f.type_config -> 'options', '[]'::jsonb)) o
          WHERE lower(btrim(CASE WHEN jsonb_typeof(o) = 'string' THEN o #>> '{}' ELSE o ->> 'name' END)) = 'rocio'
       );

UPDATE field_def f
   SET type_config = jsonb_set(
         COALESCE(f.type_config, '{}'::jsonb),
         '{options}',
         COALESCE(f.type_config -> 'options', '[]'::jsonb)
           || COALESCE((
                SELECT jsonb_agg(to_jsonb(n.name) ORDER BY n.ord)
                  FROM (VALUES ('Rocio', 1), ('Teresa', 2), ('Kevin', 3), ('House', 4)) AS n(name, ord)
                 WHERE NOT EXISTS (
                         SELECT 1
                           FROM jsonb_array_elements(COALESCE(f.type_config -> 'options', '[]'::jsonb)) o
                          WHERE lower(btrim(CASE WHEN jsonb_typeof(o) = 'string' THEN o #>> '{}' ELSE o ->> 'name' END)) = lower(n.name)
                       )
              ), '[]'::jsonb)
       )
 WHERE f.key = 'Sales Owner'
   AND f.type = 'dropdown';
