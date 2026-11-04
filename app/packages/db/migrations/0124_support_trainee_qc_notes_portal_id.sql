-- 0124 · Support Trainee, QC Notes, Portal ID (Elise, 2026-11-04).
--
-- 1. `Support Trainee` (users, People section): an OM Under Probation on the
--    work order. Its picker lists om_probation accounts only and the API
--    refuses any other name a person adds (SUPPORT_TRAINEE_KEY /
--    ROLE_LIMITED_PERSON_FIELDS in packages/shared/src/dataQuality.ts).
-- 2. `QC Notes` (long text, QC section): admins only for now — every role but
--    `admin` (and the service account) gets view and edit false on its path.
--    Super admins always see it. Loosen it in Admin › Roles or per person
--    with Adjust. Never client-safe.
-- 3. `Portal ID` (short text, Integrations section, beside Client Portal Type).
--
-- seed.ts carries the same three rows (and QC Notes' client_safe = false);
-- role is not truncated by the seed, so the grant lives here only. KEEP IN STEP.

INSERT INTO field_def (container_id, key, label, type, type_config, position)
SELECT c.id, v.key, v.label, v.type::field_type, '{}'::jsonb,
       (SELECT COALESCE(max(position), 0) FROM field_def WHERE container_id = c.id) + v.ord
  FROM container c
  CROSS JOIN (VALUES
    ('Support Trainee', 'Support Trainee', 'users',      1),
    ('QC Notes',        'QC Notes',        'long_text',  2),
    ('Portal ID',       'Portal ID',       'short_text', 3)
  ) AS v(key, label, type, ord)
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;

UPDATE field_def SET client_safe = false WHERE key = 'QC Notes';

CREATE FUNCTION pg_temp.qc_grant(p_code text, p_path text, p_grant jsonb) RETURNS void AS $$
  UPDATE role
     SET permissions = COALESCE(permissions, '{}'::jsonb)
                       || jsonb_build_object(p_path, COALESCE(permissions -> p_path, '{}'::jsonb) || p_grant)
   WHERE code = p_code;
$$ LANGUAGE sql;

SELECT pg_temp.qc_grant(r.code, 'work_orders/fields/qc/fields.QC Notes', '{"view": false, "edit": false}')
  FROM role r
 WHERE r.code NOT IN ('admin', 'service');
