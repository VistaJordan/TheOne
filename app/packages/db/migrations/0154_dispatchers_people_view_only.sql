-- 0154 · The dispatchers change nobody on a work order (Elise, 2026-11-16).
--
-- OM, Senior OM and OM Under Probation are view-only on the whole People
-- section: Assignee, AM, TL, ATL, Completion Assignee, Sales Owner, Support
-- Trainee (0147 had done it for OM Under Probation alone; the Assignee was
-- already locked for all three since 0039). View is untouched.
--
-- Any explicit `edit` a role row holds on a field under the section is set to
-- false too, so no child path keeps an older grant above the section's.
-- Per-person overrides (Adjust) are not touched. Add work order still fills
-- AM / TL / ATL / Sales Owner from the client's account team
-- (CREATE_FILLABLE_FIELD_KEYS in shared workflow.ts), and an edit of the
-- Client or Comp still refills them (that write is the system's).
--
-- Loosen it per role in Admin › Roles or per person with Adjust. role is not
-- truncated by the seed, so this lives here only.

CREATE FUNCTION pg_temp.pv_grant(p_code text, p_path text, p_grant jsonb) RETURNS void AS $$
  UPDATE role
     SET permissions = COALESCE(permissions, '{}'::jsonb)
                       || jsonb_build_object(p_path, COALESCE(permissions -> p_path, '{}'::jsonb) || p_grant)
   WHERE code = p_code;
$$ LANGUAGE sql;

SELECT pg_temp.pv_grant(c.code, 'work_orders/fields/people', '{"edit": false}')
  FROM unnest(ARRAY['om', 'senior_om', 'om_probation']) AS c(code);

SELECT pg_temp.pv_grant(r.code, k.key, '{"edit": false}')
  FROM role r
 CROSS JOIN LATERAL jsonb_each(COALESCE(r.permissions, '{}'::jsonb)) AS k(key, value)
 WHERE r.code IN ('om', 'senior_om', 'om_probation')
   AND k.key LIKE 'work_orders/fields/people/%'
   AND jsonb_typeof(k.value) = 'object'
   AND k.value ? 'edit';
