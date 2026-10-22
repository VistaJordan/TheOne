-- 0090 · Payment approval by requester and by amount (Elise, 2026-10-22).
--
-- 1. The amount bands for PAYMENT REQUESTS (rule 6.2.3, 0047) are applied
--    to Approve again (0076 had stopped asking them) and set to:
--      under $500        anyone with payments:approve
--      $500 to $3,000    TL / ATL (and Admin)
--      $3,000 and over   AM (and Admin)
--    The rows stay editable in Admin › Settings › Approval tiers; this only
--    re-states the payment bands. Vendor-bill and invoice bands are untouched.
--
-- 2. `payment_request.auto_approved`: a request that landed `approved` as it
--    was raised — an OM / Senior OM's request under $500 (shared
--    paymentApprovalVerdict) — so the ledger can say nobody clicked Approve.

ALTER TABLE payment_request
  ADD COLUMN IF NOT EXISTS auto_approved boolean NOT NULL DEFAULT false;

-- Rewrite the payment bands whatever they held (Elise named them outright).
DELETE FROM approval_tier WHERE kind = 'payment';
INSERT INTO approval_tier (kind, label, min_amount, max_amount, roles, position)
VALUES
  ('payment', 'Under $500',       0,    500,  '{}',             0),
  ('payment', '$500 to $3,000',   500,  3000, '{tl,atl,admin}', 1),
  ('payment', '$3,000 and over',  3000, NULL, '{am,admin}',     2);
