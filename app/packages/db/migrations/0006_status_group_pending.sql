-- 0006 — add 'pending' to the status_group enum.
--
-- ALONE IN THIS FILE ON PURPOSE. Postgres allows ALTER TYPE ... ADD VALUE
-- inside a transaction (12+), but the new label cannot be USED until that
-- transaction commits. The migration runner sends each file as one multi-
-- statement simple query, which Postgres wraps in an implicit transaction — so
-- assigning statuses to 'pending' here would fail with
--   unsafe use of new value "pending" of enum type status_group
-- The assignment is migration 0007.
--
-- Placed AFTER 'active' so enum ordering still reads as the pipeline does:
-- open -> active -> pending -> done -> closed.

ALTER TYPE status_group ADD VALUE IF NOT EXISTS 'pending' AFTER 'active';
