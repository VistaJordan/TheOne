-- 0113 · Client Portal Type offers 7-Eleven (Elise, 2026-10-30).
--
-- 7-11's work comes through 7-Eleven's own portal (its check-in row, 0100,
-- reads Portal "7-11"), so the dropdown gains "7-Eleven", appended when
-- missing; an admin's own additions stay. From today the field also fills
-- itself from the client's check-in row for the Client + Comp
-- (`portalTypeFromCico` in packages/shared/src/clientCico.ts): on Add work
-- order, on create, and when an edit changes the Client or the Comp.
-- Work orders on file are not back-filled.
--
-- seed.ts carries the same list — KEEP IN STEP.

UPDATE field_def f
   SET type_config = jsonb_set(
         COALESCE(f.type_config, '{}'::jsonb),
         '{options}',
         COALESCE(f.type_config -> 'options', '[]'::jsonb) || to_jsonb('7-Eleven'::text)
       )
 WHERE f.key = 'Client Portal Type'
   AND f.type = 'dropdown'
   AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(f.type_config -> 'options', '[]'::jsonb)) o
          WHERE regexp_replace(lower(CASE WHEN jsonb_typeof(o) = 'string' THEN o #>> '{}' ELSE o ->> 'name' END), '[^a-z0-9]', '', 'g')
                IN ('7eleven', '711', 'seveneleven')
       );
