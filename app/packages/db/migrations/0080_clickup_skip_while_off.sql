-- 0080 · ClickUp: what happens while the switch is off is skipped for good
-- (Elise, 2026-10-13: "only transfer what we do while it is on and ignore
-- what we do when it is off").
--
-- Turning the switch on stamps `resumed_at` and raises `needs_baseline`; the
-- next run then takes everything as it stands as already sent — the cursor
-- jumps to the newest activity row, each linked task's `pushed` is reset to
-- its current values without calling ClickUp, and work orders that arrived
-- while it was off get a `skipped` link so they are never created there.
-- Only changes made after that moment travel.

ALTER TABLE clickup_config
  ADD COLUMN resumed_at     timestamptz,
  ADD COLUMN needs_baseline boolean NOT NULL DEFAULT false;

ALTER TABLE clickup_link
  ADD COLUMN skipped boolean NOT NULL DEFAULT false;
