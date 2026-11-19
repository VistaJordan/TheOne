-- 0158 · The manager rates the work on the sign-off form (Elise, 2026-11-19).
--
-- The form (0156) now asks the manager on site for 1 to 5 stars before they
-- sign. The rating is kept on the sheet's row beside the name; it is printed
-- on the signed PDF, and a rating of 3 or fewer notifies the work order's TL
-- and ATL (2 or fewer its AM as well) — nothing is stored for that beyond the
-- ordinary app_notice rows.

ALTER TABLE wo_signoff
  ADD COLUMN signed_rating smallint CHECK (signed_rating BETWEEN 1 AND 5);
