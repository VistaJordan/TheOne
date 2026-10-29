-- Elise, 2026-10-28: a payment request that takes Cost past the NTE or the
-- approved quote is still filed, but with the requester's reason, asked in a
-- popup at submit. The reason is kept on the request (Payables, the Payments
-- queue) and copied onto the hold it raises (the manager's inbox).
ALTER TABLE payment_request ADD COLUMN IF NOT EXISTS overage_reason text;
