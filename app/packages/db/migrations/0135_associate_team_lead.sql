-- 0135 · Elise, 2026-11-13.
--
-- The `atl` role reads Associate Team Lead (it read "Assistant TL"). Only
-- the label changes: the code `atl`, its grants and every principal on it
-- stay as they are. role is not truncated by the seed, so this lives here
-- only. The work-order field keeps its short label, ATL (0112).

UPDATE role SET label = 'Associate Team Lead'
 WHERE code = 'atl' AND label IS DISTINCT FROM 'Associate Team Lead';
