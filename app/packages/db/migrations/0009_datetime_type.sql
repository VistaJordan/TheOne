-- 0009 · A 'datetime' member on field_type — Due Date, Date Created and
-- Date-Time Received carry a time of day, not just a day (founder request).
-- The enum value alone lives here; the field_def rows that USE it are updated
-- in 0010, because Postgres refuses to use an enum value added by ALTER TYPE
-- in the same transaction, and the runner executes each file as one exec.
ALTER TYPE field_type ADD VALUE IF NOT EXISTS 'datetime';
