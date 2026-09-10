-- ============================================================================
-- 0015 · Permissions as a tree, per role and per user
--
-- Until now a role carried five booleans (0005 + 0007) and that was the whole
-- permission model. This migration adds:
--
--   role.permissions               jsonb  path → {view, create, edit, delete, approve}
--   principal.permission_overrides jsonb  the same shape, for ONE person
--
-- A path is '/'-separated ('work_orders', 'work_orders/tabs/money',
-- 'work_orders/fields/finances/fields.34. Cost'). An action not set on a path
-- inherits from its parent, so a whole section switches with one entry and
-- exceptions sit underneath it. The resolver lives in @theone/shared
-- (permissions.ts) and is the same code on the API and in the browser.
--
-- The five legacy columns stay — the seed, older migrations and Jordan's
-- branch read them — and services/roles.ts keeps them in step with the tree
-- on every write. They are no longer what the server enforces.
--
-- Data note (CLAUDE.md "keep in step"): `role` is never truncated by the seed,
-- so the two roles and the baseline grants below live here ONLY.
-- ============================================================================

ALTER TABLE role
  ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE principal
  ADD COLUMN IF NOT EXISTS permission_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── Two roles the operation asked for (2026-09-04) ──────────────────────────
-- VR Officer: works the vendor-relations side — reads and updates work orders,
-- reads quotes, never builds one.
-- OM Under Probation: a dispatcher on reduced trust — the OM's day job without
-- deleting or exporting.
INSERT INTO role (code, label, description, is_system,
                  can_edit_quote, can_approve_quote, can_manage_users,
                  can_edit_wo_fields, can_view_field_history, position) VALUES
  ('vr_officer',   'VR Officer',         'Vendor relations. Updates work orders and reads quotes; does not build them.', true, false, false, false, true,  false, 75),
  ('om_probation', 'OM Under Probation', 'Dispatcher on probation — the OM''s work without delete or export.',          true, false, false, false, true,  false, 72)
ON CONFLICT (code) DO NOTHING;

-- ── Baseline tree for every role that has none yet ──────────────────────────
-- Derived from the legacy booleans so nobody loses or gains anything by this
-- migration; the Roles screen can retune every entry afterwards.
UPDATE role
   SET permissions = jsonb_build_object(
     'dashboard',            jsonb_build_object('view', true),
     'work_orders',          jsonb_build_object(
                               'view',   true,
                               'create', can_edit_wo_fields,
                               'edit',   can_edit_wo_fields,
                               'delete', code IN ('admin', 'tl', 'atl', 'am')),
     'work_orders/history',  jsonb_build_object('view', can_view_field_history),
     'work_orders/export',   jsonb_build_object('view', code NOT IN ('om_probation', 'ops_coord', 'exec_guest', 'service')),
     'quotes',               jsonb_build_object(
                               'view',    true,
                               'create',  can_edit_quote,
                               'edit',    can_edit_quote,
                               'approve', can_approve_quote),
     'payments',             jsonb_build_object('view', true, 'create', code <> 'exec_guest'),
     'vendors',              jsonb_build_object('view', true),
     'invoicing',            jsonb_build_object('view', true),
     'admin',                jsonb_build_object('view', can_manage_users, 'edit', can_manage_users)
   )
 WHERE permissions = '{}'::jsonb;

-- The exec guest is "a read-only curated rollup, no cost or profit fields":
-- say so in the tree, not just in the description.
UPDATE role
   SET permissions = permissions
     || jsonb_build_object(
          'work_orders/tabs/money',     jsonb_build_object('view', false),
          'work_orders/tabs/payables',  jsonb_build_object('view', false),
          'work_orders/fields/finances', jsonb_build_object('view', false),
          'work_orders/fields/payments', jsonb_build_object('view', false),
          'work_orders/fields/invoicing', jsonb_build_object('view', false),
          'work_orders/fields/header/nte', jsonb_build_object('view', false),
          'work_orders/comments',       jsonb_build_object('create', false))
 WHERE code = 'exec_guest';

-- Service accounts never sign in; leave them with nothing rather than a
-- baseline nobody reviewed.
UPDATE role SET permissions = '{}'::jsonb WHERE code = 'service';
