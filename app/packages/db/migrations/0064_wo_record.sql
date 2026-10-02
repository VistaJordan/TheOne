-- 0064 · The work-order record (Facilio parity batch 4) and the leftovers of
-- batches 2 and 3.
--
--   on the work order   one responsible vendor · pause / resume · an ETA ·
--                       cancel with a reason · "complete service" (note,
--                       fault code, action code, temporary fix?) · a checklist
--                       · tags with a reason · a manual NTE increase request
--   on the create form  layouts per client / trade
--   on a visit          where the check-in happened, against the site's
--                       geofence
--   on a site           events (a closure, a remodel, an incident)
--
-- Everything here is additive: new nullable columns and new tables. Nothing
-- that exists changes meaning. A pause does NOT stop any Pulse clock or SLA
-- (rule 2.4.4 stands: nothing pauses a timer) — it is a marker people see,
-- and a span the Timelog can show.
--
-- The people columns on the NEW tables are plain uuids with no FK to
-- principal where the row must survive a re-seed (configuration: codes,
-- layouts, site events); rows that hang on a work order reference task and
-- go with it.

-- ── On the work order ───────────────────────────────────────────────────────

ALTER TABLE task
  -- The one vendor responsible for the job. Technicians hired onto it stay in
  -- wo_technician (0057); this is who answers for it.
  ADD COLUMN vendor_id            uuid REFERENCES vendor(id) ON DELETE SET NULL,
  ADD COLUMN paused_at            timestamptz,
  ADD COLUMN paused_by            uuid,
  ADD COLUMN pause_reason         text,
  ADD COLUMN eta_at               timestamptz,
  ADD COLUMN eta_note             text,
  ADD COLUMN eta_by               uuid,
  ADD COLUMN cancelled_at         timestamptz,
  ADD COLUMN cancelled_by         uuid,
  ADD COLUMN cancel_reason        text,
  -- "Complete service": what was found and what was done.
  ADD COLUMN completion_note      text,
  ADD COLUMN fault_code           text,
  ADD COLUMN action_code          text,
  ADD COLUMN temporary_fix        boolean,
  ADD COLUMN service_completed_at timestamptz,
  ADD COLUMN service_completed_by uuid;

CREATE INDEX task_vendor_idx ON task (vendor_id) WHERE vendor_id IS NOT NULL;

-- Every pause, so the Timelog can say how long the job stood still.
CREATE TABLE wo_pause (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  paused_at  timestamptz NOT NULL DEFAULT now(),
  resumed_at timestamptz,
  reason     text,
  paused_by  uuid,
  resumed_by uuid
);
CREATE INDEX wo_pause_task_idx ON wo_pause (task_id, paused_at);

CREATE TABLE wo_checklist_item (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  title      text NOT NULL,
  done       boolean NOT NULL DEFAULT false,
  done_by    uuid,
  done_at    timestamptz,
  note       text,
  position   int NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wo_checklist_task_idx ON wo_checklist_item (task_id, position);

CREATE TABLE wo_tag (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  tag        text NOT NULL,
  reason     text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wo_tag_key ON wo_tag (task_id, lower(tag));
CREATE INDEX wo_tag_tag_idx ON wo_tag (lower(tag));

-- A person asks for a higher NTE; whoever decides NTE approvals says yes or
-- no. Approving writes the new NTE through the ordinary field path. This is
-- separate from the automatic `nte_override` approval task (0026), which is
-- raised when the cost passes the NTE and is left exactly as it was.
CREATE TABLE wo_nte_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  current_nte   numeric(12,2),
  requested_nte numeric(12,2) NOT NULL CHECK (requested_nte >= 0),
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'withdrawn')),
  requested_by  uuid,
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wo_nte_request_task_idx ON wo_nte_request (task_id, created_at);

-- Fault and action codes: two short lists, edited in Admin › Settings.
CREATE TABLE wo_code (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind      text NOT NULL CHECK (kind IN ('fault', 'action')),
  code      text NOT NULL,
  label     text NOT NULL,
  position  int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX wo_code_key ON wo_code (kind, lower(code));

INSERT INTO wo_code (kind, code, label, position) VALUES
  ('fault', 'WEAR',     'Normal wear',                 0),
  ('fault', 'ELEC',     'Electrical failure',          1),
  ('fault', 'MECH',     'Mechanical failure',          2),
  ('fault', 'LEAK',     'Leak',                        3),
  ('fault', 'CLOG',     'Blockage',                    4),
  ('fault', 'DAMAGE',   'Physical damage',             5),
  ('fault', 'MISUSE',   'Misuse / operator error',     6),
  ('fault', 'INSTALL',  'Faulty installation',         7),
  ('fault', 'NOFAULT',  'No fault found',              8),
  ('fault', 'OTHER',    'Other',                       9),
  ('action', 'REPAIR',  'Repaired',                    0),
  ('action', 'REPLACE', 'Replaced part',               1),
  ('action', 'REPLUNIT','Replaced unit',               2),
  ('action', 'ADJUST',  'Adjusted / calibrated',       3),
  ('action', 'CLEAN',   'Cleaned / cleared',           4),
  ('action', 'RESET',   'Reset',                       5),
  ('action', 'TEMP',    'Temporary repair',            6),
  ('action', 'QUOTE',   'Assessed, quote to follow',   7),
  ('action', 'NONE',    'No action needed',            8),
  ('action', 'OTHER',   'Other',                       9);

-- ── The create form: layouts ────────────────────────────────────────────────
-- A layout changes what "Add work order" shows for one client and / or one
-- trade: per field, off / optional / required, over the form's own setting
-- (field_def.create_mode). A layout naming neither applies to nothing; the
-- most specific match wins (client + trade, then client, then trade).

CREATE TABLE wo_form_layout (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  client     text,
  trade      text,
  -- { "<field key>": "off" | "optional" | "required" }
  fields     jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active  boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER wo_form_layout_touch BEFORE UPDATE ON wo_form_layout
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── A visit: where the check-in happened ────────────────────────────────────
-- Recorded by whoever logs the visit (from the device in the technician's
-- hand, or typed from what the technician reports). `geofence_ft` is the
-- distance from the site's pin; `geofence_result` reads it against the
-- site's boundary AS IT WAS at that moment — moving the boundary later does
-- not rewrite history.

ALTER TABLE wo_visit
  ADD COLUMN check_in_lat     double precision,
  ADD COLUMN check_in_lng     double precision,
  ADD COLUMN geofence_ft      int,
  ADD COLUMN geofence_limit_ft int,
  ADD COLUMN geofence_result  text CHECK (geofence_result IS NULL OR geofence_result IN ('inside', 'outside', 'no_site', 'no_boundary')),
  ADD COLUMN located_by       uuid,
  ADD COLUMN located_at       timestamptz;

-- ── Site events ─────────────────────────────────────────────────────────────
-- Something at a site that the people working it should know: a closure, a
-- remodel, an incident, restricted access. Shown on the site, on every work
-- order at the site while it runs, and on the Sites page.

CREATE TABLE site_event (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    uuid NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  kind       text NOT NULL DEFAULT 'notice'
             CHECK (kind IN ('closure', 'restricted_access', 'remodel', 'incident', 'inspection', 'weather', 'notice')),
  title      text NOT NULL,
  detail     text,
  starts_on  date NOT NULL DEFAULT CURRENT_DATE,
  -- NULL = until somebody ends it.
  ends_on    date,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX site_event_site_idx ON site_event (site_id, starts_on);
CREATE TRIGGER site_event_touch BEFORE UPDATE ON site_event
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
