-- 0094 · Profitability exception on Finances; a Penalties section (Elise,
-- 2026-10-22). Vocabulary: packages/shared/src/managerFlags.ts; seed.ts
-- carries the same field rows — KEEP THE THREE IN STEP.
--
-- 1. Two custom fields in the Finances section: `Profitability Exception`
--    (checkbox) and `Profitability Exception Notes` (long text, drawn as
--    "Manager notes") — the margin on this job is accepted as it is, and why.
-- 2. A Penalties section of All fields (FIELD_SECTIONS, slug `penalties`):
--    `12. Bad quote` moves there from AR (an existing field — its permission
--    path changes from work_orders/fields/ar/… to work_orders/fields/
--    penalties/…), beside the new `Penalty`, `Late Quote`, `Missed ETA`,
--    `Recall` (checkboxes) and `Penalty Description` (long text, "Manager
--    description").
-- 3. All of it is a manager's call: the dispatcher tiers, the VR Officer and
--    the OP Admin are view-only on the Penalties section and on the two
--    Finances rows (the same session-only helper as 0084 / 0085). Admin ›
--    Roles or a per-person Adjust can loosen it again.
-- None of the new fields is client-safe (#17); a Client Updates tracker
-- never carries them.

INSERT INTO field_def (container_id, key, label, type, type_config, position, client_safe)
SELECT c.id, v.key, v.label, v.type::field_type, '{}'::jsonb,
       (SELECT COALESCE(max(position), 0) FROM field_def WHERE container_id = c.id) + v.ord,
       false
  FROM container c
  CROSS JOIN (VALUES
    ('Profitability Exception',       'Profitability Exception', 'checkbox',  1),
    ('Profitability Exception Notes', 'Manager Notes',           'long_text', 2),
    ('Penalty',                       'Penalty',                 'checkbox',  3),
    ('Late Quote',                    'Late Quote',              'checkbox',  4),
    ('Missed ETA',                    'Missed ETA',              'checkbox',  5),
    ('Recall',                        'Recall',                  'checkbox',  6),
    ('Penalty Description',           'Manager Description',     'long_text', 7)
  ) AS v(key, label, type, ord)
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;

-- Bad quote was client-unsafe as an AR field (0084) and stays so in Penalties.
UPDATE field_def SET client_safe = false WHERE key = '12. Bad quote';

CREATE FUNCTION pg_temp.mf_grant(p_code text, p_path text, p_grant jsonb) RETURNS void AS $$
  UPDATE role
     SET permissions = COALESCE(permissions, '{}'::jsonb)
                       || jsonb_build_object(p_path, COALESCE(permissions -> p_path, '{}'::jsonb) || p_grant)
   WHERE code = p_code;
$$ LANGUAGE sql;

SELECT pg_temp.mf_grant(r.c, f.path, '{"edit": false}')
  FROM unnest(ARRAY['om_probation', 'om', 'senior_om', 'vr_officer', 'oa']) AS r(c)
 CROSS JOIN unnest(ARRAY[
   'work_orders/fields/penalties',
   'work_orders/fields/finances/fields.Profitability Exception',
   'work_orders/fields/finances/fields.Profitability Exception Notes'
 ]) AS f(path);
