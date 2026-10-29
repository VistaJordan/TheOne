-- 0108 · Dispatchers see payments only inside the work order (Elise,
-- 2026-10-29; UAT "Records opened by link ignore scope").
--
-- A new permission path, `payments/page` (PAYMENTS_PAGE_PERM_KEY in
-- packages/shared/src/permissions.ts), is the Payments page in the sidebar:
-- every payment across the person's work orders. `payments` view still opens
-- a work order's Payables tab. Unset, the page follows `payments` view, so
-- every other role is as it was.
--
-- For OM, Senior OM and OM Under Probation (DISPATCHER_ROLE_CODES):
--   payments            view + create on (request and see on their own work
--                       orders; Payments had been switched off for them in
--                       Admin › Roles on 2026-10-20/22 as a stopgap)
--   payments/page       view off — no Payments page, no request by link
--   approvals/payments  view off — no Payments lane in the Approvals inbox
-- Approve stays off. Roles are not truncated by the seed, so there is no seed
-- twin; Admin › Roles or a per-person Adjust can change any of it.
--
-- The same session-only helper as 0084 / 0085 / 0093: merges a grant into the
-- one path, so an action this file does not name keeps what it was.

CREATE FUNCTION pg_temp.p108_grant(p_code text, p_path text, p_grant jsonb) RETURNS void AS $$
  UPDATE role
     SET permissions = COALESCE(permissions, '{}'::jsonb)
                       || jsonb_build_object(p_path, COALESCE(permissions -> p_path, '{}'::jsonb) || p_grant)
   WHERE code = p_code;
$$ LANGUAGE sql;

SELECT pg_temp.p108_grant(r.code, 'payments', '{"view": true, "create": true, "approve": false}'),
       pg_temp.p108_grant(r.code, 'payments/page', '{"view": false}'),
       pg_temp.p108_grant(r.code, 'approvals/payments', '{"view": false}')
  FROM unnest(ARRAY['om', 'senior_om', 'om_probation']) AS r(code);
