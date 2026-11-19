-- 0159 · Hold on a payment request (Elise, 2026-11-19).
--
-- The status change hold (0123) for payments: whoever may approve or reject
-- a waiting payment request may also put it on hold — "not yet". A held
-- request stays `requested`, in the Approvals › Payments lane, in its place
-- in the oldest-first list; it can still be approved or rejected later.
-- The three columns say who held it, when, and (optionally) why; Release
-- clears them, and so does any decision.
--
-- Columns only: nothing to seed, so there is no seed twin.

ALTER TABLE payment_request
  ADD COLUMN held_by   uuid REFERENCES principal(id) ON DELETE SET NULL,
  ADD COLUMN held_at   timestamptz,
  ADD COLUMN hold_note text;
