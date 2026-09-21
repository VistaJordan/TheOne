-- 0049 · More kinds of dashboard card (Facilio parity, batch 6).
--
-- 0042 shipped four drawings of a question over the work-order set and 0044
-- added the line. This widens the list to the card types Facilio's library
-- has that ours lacked:
--
--   gauge      a number against a target — how much of the month's budget
--              is spent, how many of the week's SLAs are met
--   narrative  a block of text on the board: what this dashboard is for, who
--              to call, the definition of a number beside it
--   image      a picture (a floor plan, a logo, a QR code) by URL
--   link       a command button: one big link to a page or a saved view
--   live       a number that re-reads itself every few seconds — the wall
--              display in the dispatch room
--
-- And, in `config` rather than `kind`, a card may now ask a question of the
-- invoices, the payment requests or the vendor bills instead of the work
-- orders (`source`), so the Accounting board can be built from records that
-- exist. The shapes live in packages/shared/src/dashboards.ts.

ALTER TABLE dashboard_widget
  DROP CONSTRAINT IF EXISTS dashboard_widget_kind_check;
ALTER TABLE dashboard_widget
  ADD CONSTRAINT dashboard_widget_kind_check
  CHECK (kind IN ('number', 'bar', 'donut', 'table', 'line', 'gauge', 'narrative', 'image', 'link', 'live'));
