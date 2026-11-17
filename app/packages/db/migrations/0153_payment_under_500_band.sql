-- 0153 · Maker ≠ checker for every payment (Elise, 2026-11-16, UAT #33).
--
-- 0115 / 0149 approved a payment request under $500 as it was raised, for
-- anyone. Now every request waits for a second person unless its requester
-- could approve it themselves (payments approve + the amount's band +, for
-- Zelle / Cash App, a TL / ATL / AM) — `requesterMayApprove` in
-- services/payments.ts. That needs the under-$500 band to name who may
-- approve it: ATL, TL or AM (a super admin always may). The other payment
-- bands are 0149's, untouched; purchase requests keep 0115's "under $500
-- needs no approval". Still editable in Admin › Settings › Approval tiers.

UPDATE approval_tier
   SET roles = '{atl,tl,am}'
 WHERE kind = 'payment' AND min_amount = 0 AND max_amount = 500;
