-- 0147 · Who changes the people on a work order (Elise, 2026-11-16).
--
-- 1. Only a TL or an ATL changes the TL and ATL seats. Every other role is
--    view-only on `fields.TL` and `fields.ATL` (view untouched). Super admins
--    always may. The Add work order form still fills both from the client's
--    account team (CREATE_FILLABLE_FIELD_KEYS in shared workflow.ts), and an
--    edit of the Client or Comp still refills them (that write is the
--    system's, not the person's).
-- 2. OM Under Probation is view-only on the whole People section (Assignee,
--    AM, TL, ATL, Completion Assignee, Sales Owner, Support Trainee; the
--    Assignee was already, since 0039).
--
-- Loosen either per role in Admin › Roles or per person with Adjust. role is
-- not truncated by the seed, so this lives here only.

CREATE FUNCTION pg_temp.tl_grant(p_code text, p_path text, p_grant jsonb) RETURNS void AS $$
  UPDATE role
     SET permissions = COALESCE(permissions, '{}'::jsonb)
                       || jsonb_build_object(p_path, COALESCE(permissions -> p_path, '{}'::jsonb) || p_grant)
   WHERE code = p_code;
$$ LANGUAGE sql;

SELECT pg_temp.tl_grant(r.code, p.path, '{"edit": false}')
  FROM role r
 CROSS JOIN unnest(ARRAY[
   'work_orders/fields/people/fields.TL',
   'work_orders/fields/people/fields.ATL'
 ]) AS p(path)
 WHERE r.code NOT IN ('tl', 'atl', 'service');

SELECT pg_temp.tl_grant(r.code, p.path, '{"edit": true}')
  FROM role r
 CROSS JOIN unnest(ARRAY[
   'work_orders/fields/people/fields.TL',
   'work_orders/fields/people/fields.ATL'
 ]) AS p(path)
 WHERE r.code IN ('tl', 'atl');

SELECT pg_temp.tl_grant('om_probation', 'work_orders/fields/people', '{"edit": false}');
