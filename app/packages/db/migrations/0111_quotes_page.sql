-- 0111 · The Quotes tab stays on the work order for the dispatchers (Elise,
-- 2026-10-29).
--
-- The Quotes tab on a work order (the quote builder, since 2026-10-27) needs
-- `quotes` view, the same grant as the Quotes page in the sidebar, so turning
-- Quotes off for a role to hide the page took the tab with it. A new path,
-- `quotes/page` (QUOTES_PAGE_PERM_KEY in packages/shared/src/permissions.ts),
-- is the page alone; unset it follows `quotes` view, so no other role changes.
--
-- For OM, Senior OM and OM Under Probation (DISPATCHER_ROLE_CODES), and any
-- person whose own Adjust overrides Quotes:
--   quotes/page              takes what `quotes` view was (unset = on), so the
--                            sidebar shows exactly what it showed before
--   quotes                   view on (create / edit / approve untouched)
--   work_orders/tabs/quotes  view on
-- Roles are not truncated by the seed, so there is no seed twin; Admin › Roles
-- or a per-person Adjust can change any of it.

CREATE FUNCTION pg_temp.p111_grant(p_code text, p_path text, p_grant jsonb) RETURNS void AS $$
  UPDATE role
     SET permissions = COALESCE(permissions, '{}'::jsonb)
                       || jsonb_build_object(p_path, COALESCE(permissions -> p_path, '{}'::jsonb) || p_grant)
   WHERE code = p_code;
$$ LANGUAGE sql;

-- The page first, from the Quotes setting as it stands (only where the page
-- has not been set already).
UPDATE role
   SET permissions = COALESCE(permissions, '{}'::jsonb)
                     || jsonb_build_object('quotes/page', jsonb_build_object(
                          'view', COALESCE((permissions -> 'quotes' ->> 'view')::boolean, true)))
 WHERE code IN ('om', 'senior_om', 'om_probation')
   AND NOT (COALESCE(permissions, '{}'::jsonb) ? 'quotes/page');

SELECT pg_temp.p111_grant(r.code, 'quotes', '{"view": true}'),
       pg_temp.p111_grant(r.code, 'work_orders/tabs/quotes', '{"view": true}')
  FROM unnest(ARRAY['om', 'senior_om', 'om_probation']) AS r(code);

-- A dispatcher whose own overrides turned Quotes view off: the page keeps
-- that, the tab comes back.
UPDATE principal
   SET permission_overrides = permission_overrides
         || jsonb_build_object('quotes/page', COALESCE(permission_overrides -> 'quotes/page', '{}'::jsonb)
                                 || jsonb_build_object('view', false))
         || jsonb_build_object('quotes', (permission_overrides -> 'quotes') || '{"view": true}'::jsonb)
 WHERE role IN ('om', 'senior_om', 'om_probation')
   AND (permission_overrides -> 'quotes' ->> 'view') = 'false';
