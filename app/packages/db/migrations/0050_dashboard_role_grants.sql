-- 0050 · Which dashboards a role opens, and what each one counts.
--
-- Until now a dashboard said who could open it (dashboard.shared_roles /
-- shared_all, set by its Share button). Management wants to decide it where
-- every other "what can this role see" decision is made: Admin › Roles. So
-- visibility moves into the permission tree (0015), one path per dashboard:
--
--   dashboard/boards                      view   the default for dashboards
--                                                nobody has ticked yet
--   dashboard/boards/attention            view   the Needs Attention page
--   dashboard/boards/main                 view   the Main Dashboard page
--   dashboard/boards/<system_key | id>    view   one dashboard record
--   dashboard/boards/<ref>/scope          view   which work orders its cards
--        count — read at that exact path: true = everything, false = only
--        theirs, unset = the person's own "Which work orders" (0026/0032)
--
-- The Share button now writes these role grants (services/dashboards.ts);
-- shared_roles / shared_all stay on the row, kept in step, deciding nothing —
-- the same arrangement as the legacy can_* columns on role.
--
-- Everything below only fills paths a role has not set, so a Roles-screen
-- decision survives a re-run. Role rows are migration-owned (seed.ts never
-- truncates `role`), so nothing here needs mirroring in the seed. No scope
-- entries are written: every dashboard keeps counting exactly what it
-- counted yesterday until someone picks otherwise.

-- 1. Today's sharing on every existing dashboard becomes a grant per role.
UPDATE role r
   SET permissions = COALESCE((
         SELECT jsonb_object_agg(
                  'dashboard/boards/' || COALESCE(d.system_key, d.id::text),
                  jsonb_build_object('view', d.shared_all OR r.code = ANY(d.shared_roles)))
           FROM dashboard d
          WHERE NOT (r.permissions ? ('dashboard/boards/' || COALESCE(d.system_key, d.id::text)))
       ), '{}'::jsonb) || r.permissions;

-- 2. Both built-in pages stay open to everyone who could open them before,
--    and a dashboard nobody has ticked yet stays with its builder — the
--    "starts private" rule the Share button already had. (A shipped dashboard
--    that does not exist yet gets its grants from its own shared_roles when
--    ensureSystemDashboards first inserts it.)
UPDATE role
   SET permissions = jsonb_build_object(
         'dashboard/boards',           jsonb_build_object('view', false),
         'dashboard/boards/attention', jsonb_build_object('view', true),
         'dashboard/boards/main',      jsonb_build_object('view', true)
       ) || permissions;
