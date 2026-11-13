-- 0133 · QC Date is filled by the QC person only (Elise, 2026-11-13).
--
-- 1. Role `qc` (QC): sees every work order and nothing else for now — no
--    other sidebar section is granted, the money sections (Finances,
--    Payments, Invoicing, AR, Penalties) are hidden, the status cannot be
--    moved or requested, and `work_orders` edit is NOT granted. The one
--    thing it writes is QC Date: a save of only that field needs
--    `work_orders` view (`onlyViewLevelFields` in shared managerFlags.ts,
--    the 0120 header-flag pattern), then the field's own grant decides.
--    What else QC does is decided later in Admin › Roles.
-- 2. QC Date is edit false for every other role (view untouched). Super
--    admins always may. Loosen it per role in Admin › Roles or per person
--    with Adjust.
--
-- role is not truncated by the seed, so this lives here only.

INSERT INTO role (code, label, description, is_system, position, permissions)
VALUES (
  'qc',
  'QC',
  'Quality control. Sees the work orders and fills QC Date; nothing else for now.',
  true,
  96,
  '{
     "work_orders":                                 {"view": true},
     "work_orders/scope":                           {"view": true},
     "work_orders/status":                          {"edit": false, "create": false},
     "work_orders/lifecycle":                       {"edit": false},
     "work_orders/fields/finances":                 {"view": false, "edit": false},
     "work_orders/fields/payments":                 {"view": false, "edit": false},
     "work_orders/fields/invoicing":                {"view": false, "edit": false},
     "work_orders/fields/ar":                       {"view": false, "edit": false},
     "work_orders/fields/penalties":                {"view": false, "edit": false},
     "work_orders/fields/qc/fields.QC Date":        {"view": true, "edit": true}
   }'::jsonb
)
ON CONFLICT (code) DO NOTHING;

UPDATE role
   SET permissions = COALESCE(permissions, '{}'::jsonb)
                     || jsonb_build_object(
                          'work_orders/fields/qc/fields.QC Date',
                          COALESCE(permissions -> 'work_orders/fields/qc/fields.QC Date', '{}'::jsonb) || '{"edit": false}'::jsonb)
 WHERE code NOT IN ('qc', 'service');
