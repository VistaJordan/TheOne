-- 0044 · A fourth drawing for a dashboard card: the line.
--
-- 0042 shipped a figure, bars, a donut and a table — all of which answer
-- "how much, cut by what". None of them answers "and is that getting better
-- or worse", which is the question a manager actually asks. A line buckets
-- the same filtered set by a date field (day, week or month) and draws it in
-- time order.
--
-- Only the CHECK constraint changes: `config` already carries whatever the
-- card needs, and a line's extra keys (time_field, bucket) live there.
ALTER TABLE dashboard_widget
  DROP CONSTRAINT IF EXISTS dashboard_widget_kind_check;

ALTER TABLE dashboard_widget
  ADD CONSTRAINT dashboard_widget_kind_check
  CHECK (kind IN ('number', 'bar', 'donut', 'table', 'line'));
