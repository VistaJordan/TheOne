-- 0097 · No dispatcher changes who a work order is for (Elise, 2026-10-27).
--
-- 0093 made the Client and the FM view-only for OM Under Probation only.
-- Elise widened it: OM and Senior OM may not adjust them either. Same two
-- paths, same merge, the other two dispatcher tiers (CLIENT_FM_LOCKED_ROLES
-- in packages/shared/src/workflow.ts = REQUEST_MODE_DISPATCHER_ROLES; the
-- paths are PROBATION_LOCKED_FIELD_PATHS — keep the three in step).
-- om_probation is named again so the file states the whole rule; for it the
-- merge changes nothing.
--
-- Raising a work order is not changing it: POST /work-orders lets anyone who
-- may see these two fields fill them (CREATE_FILLABLE_FIELD_KEYS), so a
-- dispatcher's Add work order still takes a Client and an FM. The field
-- editor, bulk edit and the CSV import refuse them.
--
-- Roles are not truncated by the seed, so there is no seed twin. Admin ›
-- Roles or a per-person Adjust can loosen it again.

CREATE FUNCTION pg_temp.p97_grant(p_code text, p_path text, p_grant jsonb) RETURNS void AS $$
  UPDATE role
     SET permissions = COALESCE(permissions, '{}'::jsonb)
                       || jsonb_build_object(p_path, COALESCE(permissions -> p_path, '{}'::jsonb) || p_grant)
   WHERE code = p_code;
$$ LANGUAGE sql;

SELECT pg_temp.p97_grant(r.code, f.path, '{"edit": false}')
  FROM unnest(ARRAY['om_probation', 'om', 'senior_om']) AS r(code)
 CROSS JOIN unnest(ARRAY[
   'work_orders/fields/client/fields.Client',
   'work_orders/fields/client/fields.22. FM'
 ]) AS f(path);
