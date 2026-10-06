-- 0075 · Admin › Documentation: the living BRD, SOP and work-order lifecycle.
--
-- The documents themselves are code (packages/shared/src/docs) plus a read of
-- the live instance (GET /admin/docs/snapshot); nothing is stored. This
-- migration only opens the new admin section, admin/docs (view), to the roles
-- that review and run the operation: Admin, Team Lead, Assistant TL and
-- Account Manager. Super admins hold every section anyway. Nothing to seed.

UPDATE role SET permissions = permissions
    || jsonb_build_object('admin/docs', jsonb_build_object('view', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am') AND NOT (permissions ? 'admin/docs');
