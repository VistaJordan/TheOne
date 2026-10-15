-- 0084 · UAT round 1, Wave B — access and scope (docs/specs/uat-round-1.md).
--
-- D4: the role matrix lives here, not in clicks on one database. The pure
-- vocabulary it applies (who is a dispatcher, who sees money, which fields
-- may go to a client) is packages/shared/src/access.ts — the lists below are
-- copied from it; tests/uat-wave-b.test.ts fails when the two drift.
--
--   field_def.client_safe     #17: may this field go out on a shared Client
--                             Update? Off for the Finances, Payments (AP),
--                             Invoicing and AR sections and the money
--                             figures. seed.ts re-applies the same list after
--                             it re-inserts field_def (KEEP IN STEP).
--   principal.site_restricted M29: the site restriction is a flag. Before,
--                             "restricted" meant "has principal_site rows",
--                             so removing the last site widened a person to
--                             every site. Backfilled true for everyone who has
--                             rows today.
--   #12 invoicing             0021 gave every role invoicing view, so 0045's
--                             `WHERE NOT (permissions ? 'invoicing')` skipped
--                             the grant it meant for admin / ar / am / tl.
--                             Full to admin and ar; view to tl / atl / am
--                             (and ap, who keeps what it has); off for every
--                             role that does not see money (M13).
--   M13                       Roles below TL (everything but admin, tl, atl,
--                             am, ar, ap) lose Cost, Profit, Total Invoiced
--                             and Discount (view and edit). Margin % is the
--                             computed `margin_pct` column, a header path
--                             nobody narrows.
--   #14 / M20                 exec_guest = om_probation's grants. ops_coord =
--                             om_probation's grants minus the technician
--                             list and map, Clients and rates, and on its own
--                             work orders in request mode. vr_officer and oa
--                             request status changes; both see every work
--                             order (scope view = true): the VR officer
--                             sources technicians for any work order and is
--                             never its Assignee, the OP Admin intakes and
--                             assigns every work order — "only theirs" would
--                             show either of them an empty list. New role
--                             `hr` (system): Admin › Users and Roles, nothing
--                             else.
--
-- The role table is not truncated by the seed, so nothing here needs a twin
-- in seed.ts except the field_def flags (field_def IS truncated).

-- ── Columns ──────────────────────────────────────────────────────────────────

ALTER TABLE field_def ADD COLUMN IF NOT EXISTS client_safe boolean NOT NULL DEFAULT true;

UPDATE field_def SET client_safe = false
 WHERE key = ANY (ARRAY[
   '1. Not Fully Paid', '12. Bad quote', '16. Client NTE 🔴', '26. PPR Link', '27. Yoda Link',
   '34. Cost', 'Admin Comment', 'Audited', 'Bill For Incurred', 'Client Quote',
   'Days since Invoiced', 'Discount', 'GTG', 'Grey Flag Date', 'Invoice #', 'Invoice Date',
   'Profit', 'Quote Check', 'Total Invoiced'
 ]::text[]);

ALTER TABLE principal ADD COLUMN IF NOT EXISTS site_restricted boolean NOT NULL DEFAULT false;

UPDATE principal p SET site_restricted = true
 WHERE NOT p.is_super_admin
   AND EXISTS (SELECT 1 FROM principal_site ps WHERE ps.principal_id = p.id);

-- ── A helper for the grants below (this session only) ───────────────────────
-- Merges `grant_` into the one path's existing grant, so an action this file
-- does not name keeps what it was.

CREATE FUNCTION pg_temp.wb_grant(p_code text, p_path text, p_grant jsonb) RETURNS void AS $$
  UPDATE role
     SET permissions = COALESCE(permissions, '{}'::jsonb)
                       || jsonb_build_object(p_path, COALESCE(permissions -> p_path, '{}'::jsonb) || p_grant)
   WHERE code = p_code;
$$ LANGUAGE sql;

-- ── #12 · invoicing ──────────────────────────────────────────────────────────

SELECT pg_temp.wb_grant(c, 'invoicing', '{"view": true, "create": true, "edit": true, "approve": true}')
  FROM unnest(ARRAY['admin', 'ar']) AS c;
SELECT pg_temp.wb_grant(c, 'invoicing', '{"view": true}')
  FROM unnest(ARRAY['tl', 'atl', 'am']) AS c;

-- ── M13 · money below TL ─────────────────────────────────────────────────────
-- Every system role but the money roles (MONEY_ROLE_CODES) and the service
-- account. Custom roles made in Admin › Roles are left as their makers set them.

SELECT pg_temp.wb_grant(r.code, f.path, '{"view": false, "edit": false}')
  FROM role r
 CROSS JOIN unnest(ARRAY[
   'work_orders/fields/finances/fields.34. Cost',
   'work_orders/fields/finances/fields.Profit',
   'work_orders/fields/finances/fields.Total Invoiced',
   'work_orders/fields/finances/fields.Discount'
 ]) AS f(path)
 WHERE r.is_system
   AND r.code NOT IN ('admin', 'tl', 'atl', 'am', 'ar', 'ap', 'service');

SELECT pg_temp.wb_grant(r.code, 'invoicing', '{"view": false, "create": false, "edit": false, "approve": false}')
  FROM role r
 WHERE r.is_system
   AND r.code NOT IN ('admin', 'tl', 'atl', 'am', 'ar', 'ap', 'service');

-- ── #14 / M20 · the role matrix ──────────────────────────────────────────────

-- Exec guest: exactly what OM Under Probation holds (after M13 above).
UPDATE role g
   SET permissions = p.permissions,
       can_edit_quote = p.can_edit_quote,
       can_approve_quote = p.can_approve_quote,
       can_manage_users = p.can_manage_users,
       can_edit_wo_fields = p.can_edit_wo_fields,
       can_view_field_history = p.can_view_field_history
  FROM role p
 WHERE g.code = 'exec_guest' AND p.code = 'om_probation';

-- Ops Coordinator: OM Under Probation's grants, then the five differences.
UPDATE role g
   SET permissions = p.permissions,
       can_edit_quote = p.can_edit_quote,
       can_approve_quote = p.can_approve_quote,
       can_manage_users = p.can_manage_users,
       can_edit_wo_fields = p.can_edit_wo_fields,
       can_view_field_history = p.can_view_field_history
  FROM role p
 WHERE g.code = 'ops_coord' AND p.code = 'om_probation';

SELECT pg_temp.wb_grant('ops_coord', 'vendors', '{"view": false, "create": false, "edit": false, "delete": false}');
SELECT pg_temp.wb_grant('ops_coord', 'vendor_map', '{"view": false, "create": false}');
SELECT pg_temp.wb_grant('ops_coord', 'clients', '{"view": false, "create": false, "edit": false, "delete": false}');
SELECT pg_temp.wb_grant('ops_coord', 'contracts', '{"view": false, "create": false, "edit": false, "delete": false}');
SELECT pg_temp.wb_grant('ops_coord', 'work_orders/scope', '{"view": false}');
SELECT pg_temp.wb_grant('ops_coord', 'work_orders/status', '{"edit": false, "create": true}');

-- VR Officer and Operations Admin: request mode, every work order.
SELECT pg_temp.wb_grant(c, 'work_orders/status', '{"edit": false, "create": true}')
  FROM unnest(ARRAY['vr_officer', 'oa']) AS c;
SELECT pg_temp.wb_grant(c, 'work_orders/scope', '{"view": true}')
  FROM unnest(ARRAY['vr_officer', 'oa']) AS c;
-- oa keeps intake (0040), vr_officer keeps vendors (0057): restated so the
-- matrix reads whole here.
SELECT pg_temp.wb_grant('oa', 'intake', '{"view": true, "create": true, "edit": true}');
SELECT pg_temp.wb_grant('vr_officer', 'vendors', '{"view": true, "create": true, "edit": true}');

-- HR: people and roles only.
INSERT INTO role (code, label, description, is_system, position, permissions)
VALUES (
  'hr',
  'HR',
  'People and roles: invites users and sets their role. No work-order access.',
  true,
  95,
  '{"admin/users": {"view": true, "edit": true}, "admin/roles": {"view": true, "edit": true}}'::jsonb
)
ON CONFLICT (code) DO NOTHING;
