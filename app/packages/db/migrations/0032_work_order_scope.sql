-- 0032 · (0026 on Primary-Updates) Which work orders a person can see (rule 8.5 — the roadmap's
-- "my book / my entity").
--
-- No new column: the scope is two more paths in the permission tree (0015),
-- resolved by the same walk as everything else.
--
--   work_orders/scope            :view  true  = everything (the default: unset
--                                              inherits work_orders:view)
--                                        false = only work orders assigned to
--                                              them (bag `Assignee`, by display
--                                              name)
--   work_orders/scope/entity/<Comp> :view true  = plus every work order of that
--                                              billing entity
--
-- Per person from Admin › Users › Adjust, per role from Admin › Roles — the
-- Roles screen draws the pair as one "Which work orders" row. The API appends
-- the predicate to every list, queue, inbox and dashboard read and 403s a
-- per-work-order route for a row outside it (services/woScope.ts).

-- The dispatcher tiers start on "only theirs". Only where the path is not
-- already set, so a Roles-screen decision survives re-migration.
UPDATE role
   SET permissions = permissions
     || jsonb_build_object('work_orders/scope', jsonb_build_object('view', false))
 WHERE code IN ('om', 'om_probation', 'senior_om')
   AND NOT (permissions ? 'work_orders/scope');
