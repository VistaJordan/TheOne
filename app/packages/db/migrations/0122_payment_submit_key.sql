-- 0122 · A payment request is filed once per Submit (Elise, 2026-11-04).
--
-- Pressing Submit payment request twice, or a retry on a slow connection,
-- posted the same request twice and filed it twice (J and J1). The Request
-- payment form now sends a one-time `submit_key` (a uuid made when the form
-- is filled in, renewed by Request another); createPaymentRequest looks for
-- a request this person already filed under that key — under the task lock,
-- so two posts at once serialise — and answers it instead of filing again.
-- The unique index is the backstop. Rows on file have no key, which the
-- partial index leaves alone.
--
-- A column only: nothing to seed, so there is no seed twin.

ALTER TABLE payment_request ADD COLUMN submit_key uuid;

CREATE UNIQUE INDEX payment_request_submit_key_uniq
  ON payment_request (requested_by, submit_key)
  WHERE submit_key IS NOT NULL;
