-- ============================================================================
-- 0030 · Quote Due Date (rules 2.3.1–2.3.3), two hand-kept dates, holidays
--
-- Rule 2.3.1: an ASSESSMENT visit's check-out starts the quote clock.
-- Rule 2.3.2: due = check-out + 48 hours, with Saturdays, Sundays and the
--             holidays below skipped as WHOLE days (the clock pauses for the
--             day and resumes at the next working midnight — see
--             apps/api/src/lib/businessDays.ts). Times are America/Chicago.
-- Rule 2.3.3: the Work Orders page's built-in "Due Today" view lists the work
--             orders whose quote is due today (or overdue) and still owed —
--             status before Quote Ready.
--
--   'Quote Due Date'     COMPUTED by services/visits.ts from the latest
--                        Assessment visit's check-out (re-derived on every
--                        visit write, like the seven mirrored CICO keys); the
--                        field editor and bulk edit refuse to write it.
--   'Scheduled Date'     typed by the dispatcher — when the tech is booked.
--   'Parts Arrival Date' typed by the dispatcher — the parts ETA.
--                        Both feed the Due Today view (rule 4.1).
--
--   holiday              the System_Holiday_Table of rule 2.3.2. Configuration,
--                        not sample data: NO foreign keys and seed.ts does not
--                        truncate it (the 0012 automations reasoning), so an
--                        edit in Admin › Settings survives a re-seed.
--
-- field_def rows are seed-owned (0018's note): seed.ts declares the same three
-- fields so a fresh `setup` gets them from the seed, and this INSERT gives an
-- ALREADY-SEEDED database the rows from `npm run migrate` alone. KEEP IN STEP.
-- ============================================================================

INSERT INTO field_def (container_id, key, label, type, position)
SELECT c.id, v.key, v.label, 'datetime',
       (SELECT max(position) FROM field_def WHERE container_id = c.id) + v.n
  FROM container c
  CROSS JOIN (VALUES ('Scheduled Date',     'Scheduled Date',     1),
                     ('Parts Arrival Date', 'Parts Arrival Date', 2),
                     ('Quote Due Date',     'Quote Due Date',     3)) AS v(key, label, n)
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;

CREATE TABLE IF NOT EXISTS holiday (
  day        date PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- US federal holidays, OBSERVED dates (a holiday that falls on a weekend is
-- already skipped by the weekend rule; the observed weekday is the one that
-- pauses the clock). 2026 and 2027; Admin › Settings keeps the list going.
INSERT INTO holiday (day, name) VALUES
  ('2026-01-01', 'New Year''s Day'),
  ('2026-01-19', 'Martin Luther King Jr. Day'),
  ('2026-02-16', 'Presidents'' Day'),
  ('2026-05-25', 'Memorial Day'),
  ('2026-06-19', 'Juneteenth'),
  ('2026-07-03', 'Independence Day (observed)'),
  ('2026-09-07', 'Labor Day'),
  ('2026-10-12', 'Columbus Day'),
  ('2026-11-11', 'Veterans Day'),
  ('2026-11-26', 'Thanksgiving Day'),
  ('2026-12-25', 'Christmas Day'),
  ('2027-01-01', 'New Year''s Day'),
  ('2027-01-18', 'Martin Luther King Jr. Day'),
  ('2027-02-15', 'Presidents'' Day'),
  ('2027-05-31', 'Memorial Day'),
  ('2027-06-18', 'Juneteenth (observed)'),
  ('2027-07-05', 'Independence Day (observed)'),
  ('2027-09-06', 'Labor Day'),
  ('2027-10-11', 'Columbus Day'),
  ('2027-11-11', 'Veterans Day'),
  ('2027-11-25', 'Thanksgiving Day'),
  ('2027-12-24', 'Christmas Day (observed)')
ON CONFLICT (day) DO NOTHING;
