-- 0123 · Hold on a status change request (Elise, 2026-11-04).
--
-- A manager looking at a status change request had Approve and Reject; now a
-- third answer, Hold: "not yet". A held request stays OPEN — same row, same
-- status, same place in the oldest-first inbox — and stays on the work
-- order's header and in the Approvals inbox for every manager, who can still
-- approve or reject it later. The three columns say who held it, when, and
-- (optionally) why; Release clears them. A requester asking for a different
-- status clears them too (the hold was on the old ask).
--
-- Columns only: nothing to seed, so there is no seed twin.

ALTER TABLE approval_task
  ADD COLUMN held_by   uuid REFERENCES principal(id) ON DELETE SET NULL,
  ADD COLUMN held_at   timestamptz,
  ADD COLUMN hold_note text;
