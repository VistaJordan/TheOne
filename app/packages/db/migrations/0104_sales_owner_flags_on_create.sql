-- 0104 · Elise, 2026-10-27.
--
-- 1. Sales Owner offers Kevin and House (the account teams' salespeople;
--    "House" = nobody in particular). Appended to the dropdown's options when
--    missing, so an admin's own additions stay.
-- 2. Add work order shows Sales Owner (People section, filled from the
--    client's account team on the form) and the Emergency and Escalated
--    ticks (a Flags section). All three `optional`.
--
-- seed.ts carries the same: the Sales Owner options in CURATED_FIELDS and the
-- three keys through WO_CREATE_DEFAULT_KEYS (packages/shared/src/woCreate.ts)
-- — KEEP IN STEP.

UPDATE field_def f
   SET type_config = jsonb_set(
         COALESCE(f.type_config, '{}'::jsonb),
         '{options}',
         COALESCE(f.type_config -> 'options', '[]'::jsonb)
           || COALESCE((
                SELECT jsonb_agg(to_jsonb(n.name) ORDER BY n.ord)
                  FROM (VALUES ('Kevin', 1), ('House', 2)) AS n(name, ord)
                 WHERE NOT EXISTS (
                         SELECT 1
                           FROM jsonb_array_elements(COALESCE(f.type_config -> 'options', '[]'::jsonb)) o
                          WHERE lower(btrim(CASE WHEN jsonb_typeof(o) = 'string' THEN o #>> '{}' ELSE o ->> 'name' END)) = lower(n.name)
                       )
              ), '[]'::jsonb)
       )
 WHERE f.key = 'Sales Owner'
   AND f.type = 'dropdown';

UPDATE field_def
   SET create_mode = 'optional'
 WHERE create_mode = 'off'
   AND key IN ('Sales Owner', 'Emergency', 'Escalated');
