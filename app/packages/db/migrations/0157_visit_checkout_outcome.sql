-- 0157 · How a visit ended (Elise, 2026-11-18).
--
-- "Checked out" became four choices — Check out - Completed / Quote / Return /
-- Parts — and the choice decides where the work order goes once the
-- check-out stands (Done / Incurred, Waiting for Quote, Return Trip Needed,
-- Waiting for Parts; CHECK_OUT_STATUS_NAME in shared visitStatus.ts).
-- return_trip_needed stays (the '18. Check-in/out Status' mirror reads it)
-- and is true exactly when the outcome is 'return'.
--
-- Visits checked out before this migration with a return trip needed read
-- 'return'; the others keep NULL (nobody said how they ended).

ALTER TABLE wo_visit
  ADD COLUMN IF NOT EXISTS checkout_outcome text
    CONSTRAINT wo_visit_checkout_outcome_check
    CHECK (checkout_outcome IS NULL OR checkout_outcome IN ('completed', 'quote', 'return', 'parts'));

UPDATE wo_visit
   SET checkout_outcome = 'return'
 WHERE status = 'checked_out' AND return_trip_needed AND checkout_outcome IS NULL;
