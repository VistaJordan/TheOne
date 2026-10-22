-- 0093 · An OM Under Probation does not change who a work order is for
-- (Elise, 2026-10-22).
--
-- The Client and the FM fields become view-only for the om_probation role,
-- the way 0085 locked the NTE and the SLA dates for every dispatcher. One
-- role only (Elise's note names probation); OM and Senior OM keep the edit.
-- The paths are PROBATION_LOCKED_FIELD_PATHS in packages/shared/src/
-- workflow.ts — keep the two in step. Roles are not truncated by the seed,
-- so there is no seed twin. Admin › Roles or a per-person Adjust can loosen
-- it again.
--
-- The same session-only helper as 0084 / 0085: merges a grant into the one
-- path, so an action this file does not name keeps what it was.

CREATE FUNCTION pg_temp.p93_grant(p_code text, p_path text, p_grant jsonb) RETURNS void AS $$
  UPDATE role
     SET permissions = COALESCE(permissions, '{}'::jsonb)
                       || jsonb_build_object(p_path, COALESCE(permissions -> p_path, '{}'::jsonb) || p_grant)
   WHERE code = p_code;
$$ LANGUAGE sql;

SELECT pg_temp.p93_grant('om_probation', f.path, '{"edit": false}')
  FROM unnest(ARRAY[
   'work_orders/fields/client/fields.Client',
   'work_orders/fields/client/fields.22. FM'
 ]) AS f(path);
