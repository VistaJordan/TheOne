-- 0125 · INV/COLL (Elise, 2026-11-05).
--
-- The ClickUp checkbox "INV/COLL" had values in the bag (the seed's export)
-- but no field_def, so no screen showed it. It joins the AR section (All
-- fields) under the same key, so the values on file appear as they are.
-- Admins only for now — every role but `admin` (and the service account)
-- gets view and edit false on its path, as 0124 did for QC Notes. Super
-- admins always see it. Loosen it in Admin › Roles or per person with Adjust.
-- Never client-safe (AR is a client-unsafe section; said here as well
-- because 0084's pass over the sections ran before this row existed).
--
-- seed.ts carries the same row (and client_safe = false); role is not
-- truncated by the seed, so the grant lives here only. KEEP IN STEP.

INSERT INTO field_def (container_id, key, label, type, type_config, position)
SELECT c.id, 'INV/COLL', 'INV/COLL', 'checkbox'::field_type, '{}'::jsonb,
       (SELECT COALESCE(max(position), 0) FROM field_def WHERE container_id = c.id) + 1
  FROM container c
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;

UPDATE field_def SET client_safe = false WHERE key = 'INV/COLL';

CREATE FUNCTION pg_temp.invcoll_grant(p_code text, p_path text, p_grant jsonb) RETURNS void AS $$
  UPDATE role
     SET permissions = COALESCE(permissions, '{}'::jsonb)
                       || jsonb_build_object(p_path, COALESCE(permissions -> p_path, '{}'::jsonb) || p_grant)
   WHERE code = p_code;
$$ LANGUAGE sql;

SELECT pg_temp.invcoll_grant(r.code, 'work_orders/fields/ar/fields.INV/COLL', '{"view": false, "edit": false}')
  FROM role r
 WHERE r.code NOT IN ('admin', 'service');
