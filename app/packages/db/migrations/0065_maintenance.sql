-- 0065 · Maintenance modules (Facilio parity): job plans, the services
-- catalogue, technician time entries, work permits. The Assignment Manager
-- needs no table — it reads and writes the Assignee field and the responsible
-- vendor that already exist.
--
-- Everything is additive. The catalogue tables (service_item, job_plan and
-- its children) are configuration: no FK to principal, task or vendor, so a
-- re-seed leaves them alone. The rows that hang on a work order reference
-- task and go with it.

-- ── Services catalogue ──────────────────────────────────────────────────────

CREATE TABLE service_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text,
  name        text NOT NULL,
  trade       text,
  description text,
  unit        text NOT NULL DEFAULT 'each',
  unit_price  numeric(12,2),
  unit_cost   numeric(12,2),
  est_minutes int,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX service_item_name_key ON service_item (lower(name));

-- ── Job plans: a reusable list of steps (and services) for a kind of job ────

CREATE TABLE job_plan (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  trade       text,
  description text,
  est_minutes int,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX job_plan_name_key ON job_plan (lower(name));

CREATE TABLE job_plan_step (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id  uuid NOT NULL REFERENCES job_plan(id) ON DELETE CASCADE,
  position int NOT NULL DEFAULT 0,
  title    text NOT NULL
);
CREATE INDEX job_plan_step_plan_idx ON job_plan_step (plan_id, position);

CREATE TABLE job_plan_service (
  plan_id    uuid NOT NULL REFERENCES job_plan(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES service_item(id) ON DELETE CASCADE,
  qty        numeric(10,2) NOT NULL DEFAULT 1,
  PRIMARY KEY (plan_id, service_id)
);

-- Which plans were applied to a work order (a plan can be applied once).
CREATE TABLE wo_job_plan (
  task_id    uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  plan_id    uuid NOT NULL,
  plan_name  text NOT NULL,
  applied_by uuid,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, plan_id)
);

-- A planned-maintenance schedule may name the plan its work orders start with.
ALTER TABLE pm_schedule ADD COLUMN job_plan_id uuid;

-- The services on a work order: picked from the catalogue or typed.
CREATE TABLE wo_service (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  service_id uuid,
  name       text NOT NULL,
  unit       text NOT NULL DEFAULT 'each',
  qty        numeric(10,2) NOT NULL DEFAULT 1,
  unit_price numeric(12,2),
  unit_cost  numeric(12,2),
  note       text,
  added_by   uuid,
  added_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wo_service_task_idx ON wo_service (task_id, added_at);

-- ── Technician time entries ─────────────────────────────────────────────────
-- Who worked on the job, from when to when. An entry with no end is a running
-- timer. `vendor_id` is the technician's record when there is one; the name
-- stays as typed either way.

CREATE TABLE wo_time_entry (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  vendor_id   uuid REFERENCES vendor(id) ON DELETE SET NULL,
  tech_name   text NOT NULL,
  kind        text NOT NULL DEFAULT 'labor' CHECK (kind IN ('labor', 'travel', 'waiting')),
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  billable    boolean NOT NULL DEFAULT true,
  hourly_rate numeric(10,2),
  note        text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX wo_time_entry_task_idx ON wo_time_entry (task_id, started_at);
CREATE INDEX wo_time_entry_start_idx ON wo_time_entry (started_at);

-- ── Work permits ────────────────────────────────────────────────────────────
-- A permit hangs on a work order. draft → requested → approved (it is "active"
-- between its dates) → closed; a request can be rejected. "Expired" is not
-- stored: it is an approved permit whose last day has passed.

CREATE SEQUENCE work_permit_number_seq START 1001;

CREATE TABLE work_permit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_number text NOT NULL UNIQUE DEFAULT ('PTW-' || nextval('work_permit_number_seq')),
  task_id       uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  permit_type   text NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'requested', 'approved', 'rejected', 'closed')),
  holder        text,
  valid_from    date,
  valid_to      date,
  hazards       text,
  precautions   jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_by  uuid,
  requested_at  timestamptz,
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text,
  closed_by     uuid,
  closed_at     timestamptz,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_permit_task_idx ON work_permit (task_id);
CREATE INDEX work_permit_status_idx ON work_permit (status);

-- ── Who may do what ─────────────────────────────────────────────────────────
-- One section, `maintenance`, with a row per module underneath (unset
-- inherits the section). Managers get everything; dispatchers use the
-- modules but do not approve permits or delete catalogue rows; everyone else
-- reads.

UPDATE role SET permissions = permissions
    || jsonb_build_object('maintenance', jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true, 'approve', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am') AND NOT (permissions ? 'maintenance');

UPDATE role SET permissions = permissions
    || jsonb_build_object('maintenance', jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', false, 'approve', false),
                          'maintenance/assignment', jsonb_build_object('view', false, 'edit', false))
 WHERE code IN ('om', 'om_probation', 'senior_om', 'ops_coord', 'oa') AND NOT (permissions ? 'maintenance');

UPDATE role SET permissions = permissions
    || jsonb_build_object('maintenance', jsonb_build_object('view', true, 'create', false, 'edit', false, 'delete', false, 'approve', false),
                          'maintenance/assignment', jsonb_build_object('view', false, 'edit', false))
 WHERE code NOT IN ('admin', 'tl', 'atl', 'am', 'om', 'om_probation', 'senior_om', 'ops_coord', 'oa')
   AND NOT (permissions ? 'maintenance');
