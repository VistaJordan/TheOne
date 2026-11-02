-- 0115 · One set of approval bands for payment requests and purchase requests
-- (Elise, 2026-11-02).
--
--   under $500        no approval: approved as it is raised / submitted
--   $500 to $3,000    TL or ATL
--   $3,000 and over   AM
--
-- A super admin may always approve (tierAllows). The Admin role is no longer
-- named in the payment bands ("only AM"); rows stay editable in Admin ›
-- Settings › Approval tiers. The "under $500" band is kept with no roles so a
-- request that still waits there (an unpriced purchase request, one filed
-- before this rule) can be approved by anyone with the base permission.
-- Who skips approval under $500 is code (shared paymentApproval.ts,
-- purchaseRequestNeedsNoApproval), not a row. Vendor-bill and invoice bands
-- are untouched.

ALTER TABLE approval_tier DROP CONSTRAINT IF EXISTS approval_tier_kind_check;
ALTER TABLE approval_tier ADD CONSTRAINT approval_tier_kind_check
  CHECK (kind IN ('payment', 'vendor_bill', 'invoice', 'purchase_request'));

DELETE FROM approval_tier WHERE kind IN ('payment', 'purchase_request');
INSERT INTO approval_tier (kind, label, min_amount, max_amount, roles, position)
VALUES
  ('payment',          'Under $500',      0,    500,  '{}',       0),
  ('payment',          '$500 to $3,000',  500,  3000, '{tl,atl}', 1),
  ('payment',          '$3,000 and over', 3000, NULL, '{am}',     2),
  ('purchase_request', 'Under $500',      0,    500,  '{}',       0),
  ('purchase_request', '$500 to $3,000',  500,  3000, '{tl,atl}', 1),
  ('purchase_request', '$3,000 and over', 3000, NULL, '{am}',     2);
