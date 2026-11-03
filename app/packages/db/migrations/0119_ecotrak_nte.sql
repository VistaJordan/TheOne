-- 0119 · The NTE follows Ecotrak (Elise, 2026-11-03).
--
-- The Client NTE field (`16. Client NTE 🔴`) is the one NTE; `task.nte` is its
-- mirror. Before this, the Ecotrak sync wrote `task.nte` alone, on every
-- refresh, so the field went stale and an NTE raised here was put back to
-- Ecotrak's figure the next time anything moved on Ecotrak.
--
-- Now the sync writes the FIELD (and the mirror with it), and only when
-- Ecotrak's own NTE changed since the last one it sent us — so an edit made
-- here stands until Ecotrak's figure next moves, and the last change wins.
-- These two columns remember what Ecotrak last sent. NULL `ecotrak_nte_seen_at`
-- = never seen: the first sighting after this migration only records Ecotrak's
-- figure and changes nothing on the work order (Elise: work orders already on
-- file are not updated; changes from then on are).

ALTER TABLE cmms_wo_link ADD COLUMN IF NOT EXISTS ecotrak_nte numeric;
ALTER TABLE cmms_wo_link ADD COLUMN IF NOT EXISTS ecotrak_nte_seen_at timestamptz;
