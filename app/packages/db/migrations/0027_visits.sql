-- ============================================================================
-- 0027 · Visits — check-in / check-out as a log, not three fields
--
-- A work order is visited more than once (assess, then do the job, then a
-- return trip when the first job did not finish). Until now the operation
-- recorded ONE state on the work order: '18. Check-in/out Status' plus the two
-- stamps 0018 added. A second visit overwrote the first, and the tech who
-- went, the method they checked in by and the visit type all lived in
-- separate fields with no idea which visit they belonged to.
--
-- `wo_visit` is one row per visit: its type, its tech (name + phone), how they
-- checked in (IVR, app, phone…), and its own check-in / check-out stamps to
-- the second. The API stamps `checked_in_at` when the status moves to
-- checked_in and `checked_out_at` when it moves to checked_out
-- (services/visits.ts); both stay editable afterwards, with history.
--
-- The seven legacy bag fields — 'Visit Type', '18. Check-in/out Status',
-- 'Checked-in At', 'Checked-out At', 'Tech Name', 'Tech Phone Number',
-- 'CICO Method' — are KEPT and MIRROR THE LATEST VISIT, so list columns,
-- filters, exports, the dashboard's "no visit logged" card and any automation
-- that triggers on the status keep reading what they read before. They are
-- no longer written by hand: the field editor refuses them and points at the
-- visit log.
--
-- `fm_cico_method` is the "database of the method for each client": which
-- check-in method an FM company uses. A new visit takes its method from the
-- work order's FM ('22. FM') so nobody has to remember; it can still be
-- changed per visit. Maintained from Admin › Custom fields.
--
-- Audit: every visit write lands in activity_log on the WORK ORDER
-- (entity_type 'task') as visit_created / visit_updated / visit_deleted with
-- whole before/after snapshots under field 'visit:<id>', beside the mirror
-- field_updated rows it caused (stamped via 'visit').
--
-- Permissions: the CICO field section — work_orders/fields/cico view / edit —
-- gates reading and writing visits, exactly as it gated the old fields.
-- ============================================================================

CREATE TABLE IF NOT EXISTS wo_visit (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id            uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  seq                int  NOT NULL,                       -- Visit 1, 2, 3… per work order
  visit_type         text NOT NULL,                       -- 'Assessment' | 'Job' | 'Return trip' (the Visit Type vocabulary)
  status             text NOT NULL DEFAULT 'planned'
                     CHECK (status IN ('planned', 'checked_in', 'checked_out')),
  return_trip_needed boolean NOT NULL DEFAULT false,      -- the old 'Checked-out - RTN'
  tech_name          text,
  tech_phone         text,
  method             text,                                -- 'IVR' | 'App' | 'Phone' | 'Portal' | 'Email' | 'Manual'
  checked_in_at      timestamptz,
  checked_out_at     timestamptz,
  checked_in_by      uuid REFERENCES principal(id) ON DELETE SET NULL,
  checked_out_by     uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_by         uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, seq)
);

CREATE INDEX IF NOT EXISTS wo_visit_by_task ON wo_visit (task_id, seq);

DROP TRIGGER IF EXISTS wo_visit_touch ON wo_visit;
CREATE TRIGGER wo_visit_touch BEFORE UPDATE ON wo_visit
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which check-in method each FM company uses. Keyed by the FM name exactly as
-- the '22. FM' dropdown spells it; the lookup trims and ignores case.
CREATE TABLE IF NOT EXISTS fm_cico_method (
  fm         text PRIMARY KEY,
  method     text NOT NULL,
  updated_by uuid REFERENCES principal(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 'Return trip' joins the Visit Type vocabulary (seed.ts §4 carries the same
-- three options — keep in step). Only databases whose dropdown lacks it change.
UPDATE field_def
   SET type_config = jsonb_set(
         type_config,
         '{options}',
         COALESCE(type_config->'options', '[]'::jsonb) || '["Return trip"]'::jsonb)
 WHERE key = 'Visit Type'
   AND NOT (COALESCE(type_config->'options', '[]'::jsonb) ? 'Return trip');
