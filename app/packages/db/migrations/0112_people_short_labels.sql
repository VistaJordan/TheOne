-- 0112 · People seats read AM, TL, ATL (Elise, 2026-10-30).
--
-- The Account Manager, Team Lead and Assistant Team Lead fields are labelled
-- by their short names on the work order (People) and on Add work order.
-- Only the label changes; the keys (AM, TL, ATL), permissions paths and
-- values stay as they are. seed.ts carries the same labels — KEEP IN STEP.

UPDATE field_def SET label = 'AM'  WHERE key = 'AM'  AND label IS DISTINCT FROM 'AM';
UPDATE field_def SET label = 'TL'  WHERE key = 'TL'  AND label IS DISTINCT FROM 'TL';
UPDATE field_def SET label = 'ATL' WHERE key = 'ATL' AND label IS DISTINCT FROM 'ATL';
