-- 0129 · Dispatchers do not change what a work order is (Elise, 2026-11-10).
--
-- OM, Senior OM and OM Under Probation become view-only on the WO
-- description, the client's AFM, the store, the site location (17. Address
-- and the four parts that fill from it: Street Address, City, State, Zip
-- Code), the Comp and the IVR link and PIN. Same merge as 0097 (Client and
-- FM). The paths are DISPATCHER_INTAKE_LOCKED_FIELD_KEYS through
-- fieldPermKey in packages/shared/src/workflow.ts and permissions.ts; the
-- roles are CLIENT_FM_LOCKED_ROLES — keep the three in step
-- (tests/dispatcher-intake-lock.test.ts pins them to this file).
--
-- Raising a work order is not changing it: POST /work-orders lets anyone who
-- may see these fields fill them (CREATE_FILLABLE_FIELD_KEYS), so a
-- dispatcher's Add work order still takes them. The field editor, bulk edit
-- and the CSV import refuse them.
--
-- Roles are not truncated by the seed, so there is no seed twin. Admin ›
-- Roles or a per-person Adjust can loosen it again.

CREATE FUNCTION pg_temp.p129_grant(p_code text, p_path text, p_grant jsonb) RETURNS void AS $$
  UPDATE role
     SET permissions = COALESCE(permissions, '{}'::jsonb)
                       || jsonb_build_object(p_path, COALESCE(permissions -> p_path, '{}'::jsonb) || p_grant)
   WHERE code = p_code;
$$ LANGUAGE sql;

SELECT pg_temp.p129_grant(r.code, f.path, '{"edit": false}')
  FROM unnest(ARRAY['om_probation', 'om', 'senior_om']) AS r(code)
 CROSS JOIN unnest(ARRAY[
   'work_orders/fields/overview/fields.35. WO Description',
   'work_orders/fields/client/fields.✅ Client AFM',
   'work_orders/fields/client/fields.Store',
   'work_orders/fields/site/fields.17. Address',
   'work_orders/fields/site/fields.Street Address',
   'work_orders/fields/site/fields.City',
   'work_orders/fields/site/fields.State',
   'work_orders/fields/site/fields.Zip Code',
   'work_orders/fields/more/fields.21. Comp',
   'work_orders/fields/cico/fields.25. IVR Link',
   'work_orders/fields/cico/fields.30. IVR Pin'
 ]) AS f(path);
