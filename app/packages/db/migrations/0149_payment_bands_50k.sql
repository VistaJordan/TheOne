-- 0149 · Payment approval bands, one ladder (Elise, 2026-11-16, UAT #8 / #36).
--
--   under $500           no approval: approved as it is raised (the dispatchers)
--   $500 to $3,000       ATL, TL or AM
--   $3,000 to $5,000     TL or AM
--   $5,000 to $50,000    AM
--   $50,000 and over     a super admin only
--
-- Each level approves everything under its ceiling, so an AM is no longer
-- refused a $2,000 payment (0115 had kept $500–3,000 to TL / ATL alone).
-- 'super_admin' is not a role code (TIER_SUPER_ADMIN_ONLY in shared
-- approvalTiers.ts): no role holds it, and tierAllows lets a super admin
-- through every band, so the top band is theirs alone. Purchase-request,
-- vendor-bill and invoice bands are untouched. Still editable in Admin ›
-- Settings › Approval tiers.

DELETE FROM approval_tier WHERE kind = 'payment';
INSERT INTO approval_tier (kind, label, min_amount, max_amount, roles, position)
VALUES
  ('payment', 'Under $500',          0,     500,   '{}',            0),
  ('payment', '$500 to $3,000',      500,   3000,  '{atl,tl,am}',   1),
  ('payment', '$3,000 to $5,000',    3000,  5000,  '{tl,am}',       2),
  ('payment', '$5,000 to $50,000',   5000,  50000, '{am}',          3),
  ('payment', '$50,000 and over',    50000, NULL,  '{super_admin}', 4);
