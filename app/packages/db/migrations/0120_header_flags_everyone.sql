-- 0120 · The Emergency and Escalation buttons are everyone's (Elise, 2026-11-03).
--
-- The work-order header draws both buttons for whoever may edit the field.
-- Until now that left out every role whose `work_orders` edit or Overview
-- section said no, and 0038 had made the Escalated flag view-only for the
-- three dispatcher tiers. Every role now gets view + edit on both fields,
-- 0038's lock included; the field-save route lets a save of only these two
-- through on `work_orders` view (onlyHeaderFlags in packages/shared/src/
-- managerFlags.ts).
--
-- One limit stays in code, not here: clearing an escalation is a TL, ATL or
-- AM's (Admin and super admins too) — mayClearEscalation, asked by the field
-- editor and bulk edit (403 ESCALATION_CLEAR_FORBIDDEN).
--
-- Roles are not truncated by the seed, so there is no seed twin. Per-person
-- overrides are left as they are. The same session-only helper as 0093.

CREATE FUNCTION pg_temp.p120_grant(p_path text, p_grant jsonb) RETURNS void AS $$
  UPDATE role
     SET permissions = COALESCE(permissions, '{}'::jsonb)
                       || jsonb_build_object(p_path, COALESCE(permissions -> p_path, '{}'::jsonb) || p_grant)
   WHERE code <> 'service';
$$ LANGUAGE sql;

SELECT pg_temp.p120_grant(f.path, '{"view": true, "edit": true}')
  FROM unnest(ARRAY[
   'work_orders/fields/overview/fields.Emergency',
   'work_orders/fields/overview/fields.Escalated'
  ]) AS f(path);
