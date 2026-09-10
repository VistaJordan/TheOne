-- 0010 · Retype the three timestamp-bearing fields to datetime (enum member
-- added in 0009). field_def rows are seed-owned (truncated + rebuilt — see
-- 0007's data note), so seed.ts §4 declares the same three types; this UPDATE
-- exists so an ALREADY-SEEDED pgdata picks the change up from `npm run
-- migrate` alone, without wiping local edits on a re-seed. Values already in
-- the bag stay as they are: a date-only string is a valid datetime with no
-- time part, and the filter compiler's guarded casts accept both.
UPDATE field_def SET type = 'datetime'
 WHERE key IN ('Due Date', 'Date Created', 'Date-Time Received');
