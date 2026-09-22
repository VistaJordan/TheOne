-- 0051 · Planned maintenance — work orders raised by the calendar.
--
-- A schedule is one recurring job at one place: what it is (client, store,
-- trade, description, NTE, who dispatches it) and how often (every N days /
-- weeks / months / years from a start date, to an end date). The app raises a
-- work order for each due date `lead_days` ahead, in the "PM Sched" status
-- (0020), with WO # <code>-<due date>, and records the raise as an occurrence
-- so the same date is never raised twice and the schedule keeps its history.
-- Raising runs on every read of the /planned-maintenance page, on "Raise now",
-- and on the daily cron (vercel.json → /api/webhooks/planned-maintenance-run,
-- CRON_SECRET) — services/plannedMaintenance.ts.
--
-- Client, store and trade stay plain text like they are on the task; the
-- portfolio batch promotes them to records and this table moves with them.
-- Assignee is a display name, matched the way the 0032 scope matches it.

CREATE SEQUENCE IF NOT EXISTS pm_schedule_code_seq;

CREATE TABLE IF NOT EXISTS pm_schedule (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- PM-0001: the prefix of every work order this schedule raises.
  code            text NOT NULL UNIQUE
                    DEFAULT 'PM-' || lpad(nextval('pm_schedule_code_seq')::text, 4, '0'),
  name            text NOT NULL,
  client          text,
  billing_entity  text,
  store           text,
  site_name       text,
  address         text,
  city            text,
  state           text,
  trade           text,
  description     text,
  nte             numeric(12,2),
  assignee        text,
  every           int  NOT NULL DEFAULT 1 CHECK (every >= 1 AND every <= 365),
  unit            text NOT NULL DEFAULT 'month' CHECK (unit IN ('day', 'week', 'month', 'year')),
  starts_on       date NOT NULL DEFAULT CURRENT_DATE,
  ends_on         date,
  lead_days       int  NOT NULL DEFAULT 7 CHECK (lead_days >= 0 AND lead_days <= 365),
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pm_schedule_active_idx ON pm_schedule(active, starts_on);
CREATE INDEX IF NOT EXISTS pm_schedule_client_idx ON pm_schedule(client);

-- One row per due date the schedule has dealt with: raised (task_id set) or
-- skipped. The UNIQUE is what makes a raise idempotent across the page read,
-- the button and the cron running at once.
CREATE TABLE IF NOT EXISTS pm_occurrence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id  uuid NOT NULL REFERENCES pm_schedule(id) ON DELETE CASCADE,
  due_on       date NOT NULL,
  status       text NOT NULL DEFAULT 'raised' CHECK (status IN ('raised', 'skipped')),
  task_id      uuid REFERENCES task(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, due_on)
);

CREATE INDEX IF NOT EXISTS pm_occurrence_task_idx ON pm_occurrence(task_id);

-- The work order knows where it came from, so the detail page can say so and
-- a list filter can find every PM work order. Deleting a schedule keeps its
-- work orders (they are real work, possibly done) and just unlinks them.
ALTER TABLE task ADD COLUMN IF NOT EXISTS pm_schedule_id uuid REFERENCES pm_schedule(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS task_pm_schedule_idx ON task(pm_schedule_id);

DROP TRIGGER IF EXISTS pm_schedule_touch ON pm_schedule;
CREATE TRIGGER pm_schedule_touch BEFORE UPDATE ON pm_schedule
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Who may plan maintenance. The managers who accept and assign work (0036)
-- own the schedules; the dispatcher tiers and the coordinator can read them
-- so a PM work order on their list is explicable. Only where the path is not
-- already set, so a Roles-screen decision survives a re-run. Role rows are
-- migration-owned (seed.ts never truncates `role`).
UPDATE role
   SET permissions = permissions
     || jsonb_build_object('planned_maintenance', jsonb_build_object(
          'view', true, 'create', true, 'edit', true, 'delete', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am')
   AND NOT (permissions ? 'planned_maintenance');

UPDATE role
   SET permissions = permissions
     || jsonb_build_object('planned_maintenance', jsonb_build_object('view', true))
 WHERE code IN ('om', 'senior_om', 'om_probation', 'ops_coord', 'oa')
   AND NOT (permissions ? 'planned_maintenance');
