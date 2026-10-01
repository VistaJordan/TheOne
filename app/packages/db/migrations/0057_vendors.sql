-- 0057 · Vendors and technicians, the technician map, and hiring onto a work
--        order.
--
-- Two older tools do this job today and keep doing it, untouched, until The
-- One replaces them: VR - CRM (the vendor relations team's vendor records) and
-- Tech Locator (the dispatchers' map). Nothing here reads or writes either of
-- them; this is The One's own copy of what they do, starting empty.
--
-- THE RECORD. `vendor` (0001: name, trades, phone, city, state) grows into the
-- full record. One table holds both kinds:
--
--   kind 'vendor'  a company the VR team recruited and screened (the CRM's
--                  vendors, Tech Locator's "VR Data")
--   kind 'tech'    a technician a dispatcher has worked with (Tech Locator's
--                  "previous technicians")
--
-- The columns below are the ones the list, the filters and the map read; the
-- long tail of the CRM's profile (trade-specific capabilities, workflow
-- answers, insurance check-boxes, notes per section) lives in `details`
-- (jsonb), keyed by the catalogue in packages/shared/src/vendors.ts, so a
-- later profile section needs no migration. `trades` (0001) stays and is kept
-- as primary + secondary by the service — the Quo thread and the payables
-- still read it. Removal is a soft delete (`deleted_at`): payables, payment
-- requests and vendor bills point at vendors.
--
-- WHO SEES WHOM. `owner_id` is the VR rep who owns the vendor (the CRM's
-- "owned" scope). `vendor_dispatcher` is Tech Locator's ownership: the
-- dispatchers who have worked with a technician. A dispatcher limited to
-- "only theirs" sees on the map the technicians linked to them — and logging
-- a visit with a technician, or hiring one, adds the link, so whoever they
-- work with shows up for them next time.
--
-- BLACKLIST. Dispatchers cannot remove a technician; they can leave a note
-- and mark one blacklisted (reason required). The flag is on the record for
-- everyone; clearing it is a manager's act. Every note is kept.
--
-- THE MAP. Opened from a work order only, centred on the work order's own
-- ZIP / city (geo_zip, geo_city — 0056). `vendor_location` holds the points:
-- a vendor's home city is its primary location, a technician may have
-- several. `vendor_map_log` records each time someone opens the map (the
-- old "search log"); more than the daily number in `vendor_setting` raises an
-- alert in Admin › Vendors & map — an alert only, nobody is blocked.
--
-- HIRING. `wo_technician` is the work order's own list of technicians (the
-- People tab). Hire from the map adds a row; a visit can then pick from that
-- list, or search any technician. `wo_visit.vendor_id` remembers which
-- record a visit's technician was (the name and phone stay on the visit as
-- typed, so the mirrored fields and every old visit are unchanged).
--
-- PREFERRED VENDORS. `preferred_vendor`: for a client, a trade, or the pair
-- (optionally one state), the vendors we would rather use, ranked. The map
-- marks them and lists them first.
--
-- INSURANCE DATES. `vendor_expiry`: one row per (company, insurance type)
-- date. Only the LATEST date of each kind counts as current — a renewed
-- policy's old date no longer marks anybody expired. Hiring a vendor whose
-- COI is missing or expired warns; it never blocks.
--
-- Permissions (all per role in Admin › Roles, per person from Adjust):
--   vendors                      view / create / edit / delete — the Vendors section
--   vendors/scope                everything, or only the vendors they own
--   vendors/blacklist            create = add a note / mark blacklisted;
--                                edit   = clear a blacklist
--   vendor_map                   view = open the map on a work order;
--                                create = hire a technician onto it
--   vendor_map/techs             all technicians, or only theirs
--   vendor_map/vr                see the VR team's vendors on the map
--   vendor_map/statewide         see statewide vendors of the work order's state
--   vendor_map/nationwide        see nationwide vendors
--   vendor_map/subcontractors    see subcontractor technicians
--   vendor_map/add               create = add a new technician
--   admin/vendors                Admin › Vendors & map (settings, preferred
--                                vendors, statuses, the map alerts)

-- ── The record ───────────────────────────────────────────────────────────────

ALTER TABLE vendor
  ADD COLUMN kind              text NOT NULL DEFAULT 'vendor' CHECK (kind IN ('vendor', 'tech')),
  ADD COLUMN status            text NOT NULL DEFAULT 'NEW',
  ADD COLUMN brand_source      text,
  ADD COLUMN owner_id          uuid REFERENCES principal(id) ON DELETE SET NULL,
  ADD COLUMN priority          text CHECK (priority IS NULL OR priority IN ('HIGH', 'MEDIUM', 'LOW')),
  ADD COLUMN email             text,
  ADD COLUMN legal_name        text,
  ADD COLUMN dba_name          text,
  ADD COLUMN primary_trade     text,
  ADD COLUMN secondary_trades  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN zip               text,
  -- coverage
  ADD COLUMN nationwide        boolean NOT NULL DEFAULT false,
  ADD COLUMN statewide         boolean NOT NULL DEFAULT false,
  ADD COLUMN coverage_states   text[] NOT NULL DEFAULT '{}',
  ADD COLUMN max_travel_radius text,
  -- availability (NULL = not asked yet)
  ADD COLUMN emergency_same_day boolean,
  ADD COLUMN after_hours        boolean,
  ADD COLUMN weekends           boolean,
  ADD COLUMN holiday_emergency  boolean,
  ADD COLUMN estimated_response_time text,
  -- rates
  ADD COLUMN regular_hourly_rate     numeric(12,2),
  ADD COLUMN after_hours_rate        numeric(12,2),
  ADD COLUMN weekend_emergency_rate  numeric(12,2),
  ADD COLUMN trip_charge             numeric(12,2),
  ADD COLUMN diagnostic_fee          numeric(12,2),
  ADD COLUMN minimum_charge          numeric(12,2),
  ADD COLUMN payment_methods         text[] NOT NULL DEFAULT '{}',
  ADD COLUMN accepts_payment_after_30_days boolean,
  -- contact
  ADD COLUMN primary_contact_name text,
  ADD COLUMN primary_contact_role text,
  ADD COLUMN dispatch_phone       text,
  ADD COLUMN billing_email        text,
  -- compliance intake
  ADD COLUMN w9_received       text NOT NULL DEFAULT 'PENDING' CHECK (w9_received IN ('YES', 'NO', 'PENDING')),
  ADD COLUMN msa_signed        text NOT NULL DEFAULT 'PENDING' CHECK (msa_signed IN ('YES', 'NO', 'PENDING')),
  ADD COLUMN coi_received      text NOT NULL DEFAULT 'PENDING' CHECK (coi_received IN ('YES', 'NO', 'PENDING')),
  ADD COLUMN coi_approved      text NOT NULL DEFAULT 'PENDING' CHECK (coi_approved IN ('YES', 'NO', 'PENDING')),
  ADD COLUMN compliance_status text NOT NULL DEFAULT 'MISSING_DOCS'
                                 CHECK (compliance_status IN ('MISSING_DOCS', 'IN_REVIEW', 'APPROVED', 'EXPIRED', 'REJECTED')),
  -- technicians
  ADD COLUMN work_orders_count int NOT NULL DEFAULT 0,
  ADD COLUMN is_subcontractor  boolean NOT NULL DEFAULT false,
  -- blacklist
  ADD COLUMN blacklisted       boolean NOT NULL DEFAULT false,
  ADD COLUMN blacklisted_at    timestamptz,
  ADD COLUMN blacklisted_by    uuid REFERENCES principal(id) ON DELETE SET NULL,
  ADD COLUMN blacklist_reason  text,
  -- data quality
  ADD COLUMN flagged_duplicate boolean NOT NULL DEFAULT false,
  ADD COLUMN duplicate_of      uuid REFERENCES vendor(id) ON DELETE SET NULL,
  ADD COLUMN notes             text,
  ADD COLUMN details           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- where an imported row came from ('vr_crm' | 'tech_locator' + its id there),
  -- so a later import can update the row it made instead of adding a twin
  ADD COLUMN ext_source        text,
  ADD COLUMN ext_id            text,
  ADD COLUMN created_by        uuid REFERENCES principal(id) ON DELETE SET NULL,
  ADD COLUMN deleted_at        timestamptz;

CREATE INDEX vendor_kind_idx    ON vendor(kind) WHERE deleted_at IS NULL;
CREATE INDEX vendor_status_idx  ON vendor(status) WHERE deleted_at IS NULL;
CREATE INDEX vendor_owner_idx   ON vendor(owner_id);
CREATE INDEX vendor_trade_idx   ON vendor(primary_trade);
CREATE INDEX vendor_state_idx   ON vendor(state);
CREATE INDEX vendor_name_idx    ON vendor(lower(name));
CREATE UNIQUE INDEX vendor_ext_idx ON vendor(ext_source, ext_id) WHERE ext_id IS NOT NULL;

-- The vendors that exist already (the payables' and the Quo line's) are
-- companies we work with: they keep working, and read as Active.
UPDATE vendor SET status = 'ACTIVE', primary_trade = trades[1]
 WHERE primary_trade IS NULL;

-- Every phone a vendor answers on, as digits ('14095550143'), so "is this
-- number already on file" is one indexed lookup. vendor.phone (0001) stays the
-- one shown first.
CREATE TABLE vendor_phone (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id  uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  digits     text NOT NULL,
  display    text NOT NULL,
  label      text,
  position   int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, digits)
);
CREATE INDEX vendor_phone_digits_idx ON vendor_phone(digits);

INSERT INTO vendor_phone (vendor_id, digits, display)
SELECT id,
       CASE WHEN length(regexp_replace(phone, '\D', '', 'g')) = 10
            THEN '1' || regexp_replace(phone, '\D', '', 'g')
            ELSE regexp_replace(phone, '\D', '', 'g') END,
       phone
  FROM vendor
 WHERE phone IS NOT NULL AND length(regexp_replace(phone, '\D', '', 'g')) >= 7
ON CONFLICT DO NOTHING;

CREATE TABLE vendor_contact (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id  uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  name       text NOT NULL,
  role       text,
  phone      text,
  email      text,
  position   int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_contact_vendor_idx ON vendor_contact(vendor_id);

-- Where a vendor is, as points the map can measure from. lat / lng are NULL
-- when the city could not be placed — the record is then listed under "Not on
-- the map" for someone to correct, instead of silently never appearing.
CREATE TABLE vendor_location (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id  uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  city       text,
  state      text,
  zip        text,
  lat        double precision,
  lng        double precision,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_location_vendor_idx ON vendor_location(vendor_id);
CREATE INDEX vendor_location_point_idx  ON vendor_location(lat, lng) WHERE lat IS NOT NULL;
CREATE UNIQUE INDEX vendor_location_primary_idx ON vendor_location(vendor_id) WHERE is_primary;

INSERT INTO vendor_location (vendor_id, city, state, lat, lng, is_primary)
SELECT v.id, v.city, upper(v.state), g.lat, g.lng, true
  FROM vendor v
  LEFT JOIN geo_city g
    ON g.state = upper(v.state)
   AND g.name_key = regexp_replace(
         regexp_replace(
           regexp_replace(btrim(regexp_replace(regexp_replace(lower(v.city), '[.''’]', '', 'g'), '[^a-z0-9]+', ' ', 'g')),
                          '\msaint\M', 'st', 'g'),
           '\mmount\M', 'mt', 'g'),
         '\mfort\M', 'ft', 'g')
 WHERE v.city IS NOT NULL AND btrim(v.city) <> '';

-- Tech Locator's ownership: the dispatchers who have worked with a vendor.
CREATE TABLE vendor_dispatcher (
  vendor_id    uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'added', 'visit', 'hire', 'import')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_id, principal_id)
);
CREATE INDEX vendor_dispatcher_principal_idx ON vendor_dispatcher(principal_id);

-- Notes on a vendor, append-only. A blacklist and its clearing are notes too,
-- so the reason and who said it stay with the record.
CREATE TABLE vendor_note (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id  uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES principal(id) ON DELETE SET NULL,
  kind       text NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'blacklist', 'blacklist_cleared')),
  body       text NOT NULL,
  task_id    uuid REFERENCES task(id) ON DELETE SET NULL,   -- the work order it was written from, if any
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_note_vendor_idx ON vendor_note(vendor_id, created_at DESC);

CREATE TABLE vendor_expiry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id      uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  entity         text,                 -- the company the certificate names (a brand source key), or NULL
  insurance_type text NOT NULL,        -- 'COI', 'General liability', 'Workers comp', 'License', …
  expires_on     date NOT NULL,
  created_by     uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_expiry_vendor_idx ON vendor_expiry(vendor_id, expires_on);

-- ── The lists the record picks from (wired: every dropdown reads these) ──────

CREATE TABLE vendor_status (
  key        text PRIMARY KEY,
  label      text NOT NULL,
  color      text NOT NULL DEFAULT 'slate',
  position   int  NOT NULL DEFAULT 0,
  is_system  boolean NOT NULL DEFAULT false,   -- the app sets or reads it by key; cannot be deleted
  is_active  boolean NOT NULL DEFAULT true
);
INSERT INTO vendor_status (key, label, color, position, is_system) VALUES
  ('NEW',          'New',          'slate', 0, true),
  ('INTERESTED',   'Interested',   'green', 1, true),
  ('READY',        'Ready',        'blue',  2, true),
  ('ACTIVE',       'Active',       'teal',  3, true),
  ('DISQUALIFIED', 'Disqualified', 'red',   4, true),
  ('INACTIVE',     'Inactive',     'gray',  5, true);

CREATE TABLE vendor_brand_source (
  key        text PRIMARY KEY,
  label      text NOT NULL,
  position   int  NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true
);
INSERT INTO vendor_brand_source (key, label, position) VALUES
  ('SEAMLESS_FM',  'Seamless FM',  0),
  ('BKR_NATIONAL', 'BKR National', 1),
  ('BOTH',         'Both',         2);

-- The trades a vendor can be filed under. Seeded with the CRM's list; the
-- work-order Trade field keeps its own options, and the map matches the two
-- by name.
CREATE TABLE vendor_trade (
  name       text PRIMARY KEY,
  position   int  NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true
);
INSERT INTO vendor_trade (name, position) VALUES
  ('Appliance', 0), ('Electric', 1), ('General Contracting', 2), ('Handyman', 3),
  ('HVAC', 4), ('HVAC PM', 5), ('Janitorial', 6), ('Landscaping', 7),
  ('Locksmith', 8), ('Overhead Door', 9), ('Pest Control', 10), ('Plumbing', 11),
  ('PM', 12), ('Refrigeration', 13), ('Refrigeration PM', 14), ('Roofing', 15);
-- Trades the existing vendors already carry.
INSERT INTO vendor_trade (name, position)
SELECT DISTINCT t, 100 FROM vendor, unnest(trades) AS t WHERE btrim(t) <> ''
ON CONFLICT DO NOTHING;

-- ── Preferred vendors ────────────────────────────────────────────────────────

CREATE TABLE preferred_vendor (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client     text,                 -- the work order's client, or NULL = any client
  trade      text,                 -- the work order's trade, or NULL = any trade
  state      text,                 -- optional: only in this state
  vendor_id  uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  rank       int  NOT NULL DEFAULT 1,
  note       text,
  created_by uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (client IS NOT NULL OR trade IS NOT NULL)
);
CREATE INDEX preferred_vendor_match_idx ON preferred_vendor(lower(client), lower(trade));
CREATE INDEX preferred_vendor_vendor_idx ON preferred_vendor(vendor_id);
CREATE TRIGGER preferred_vendor_touch BEFORE UPDATE ON preferred_vendor
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── The work order's technicians ─────────────────────────────────────────────

CREATE TABLE wo_technician (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  vendor_id   uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  hired_by    uuid REFERENCES principal(id) ON DELETE SET NULL,
  hired_at    timestamptz NOT NULL DEFAULT now(),
  released_by uuid REFERENCES principal(id) ON DELETE SET NULL,
  released_at timestamptz,
  note        text,
  UNIQUE (task_id, vendor_id)
);
CREATE INDEX wo_technician_task_idx   ON wo_technician(task_id);
CREATE INDEX wo_technician_vendor_idx ON wo_technician(vendor_id);

ALTER TABLE wo_visit ADD COLUMN vendor_id uuid REFERENCES vendor(id) ON DELETE SET NULL;
CREATE INDEX wo_visit_vendor_idx ON wo_visit(vendor_id) WHERE vendor_id IS NOT NULL;

-- ── The map: its log and its settings ────────────────────────────────────────

CREATE TABLE vendor_map_log (
  id            bigserial PRIMARY KEY,
  principal_id  uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  task_id       uuid REFERENCES task(id) ON DELETE SET NULL,
  place         text,                    -- 'Toledo, OH 43623' — what the map centred on
  results_count int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_map_log_who_idx ON vendor_map_log(principal_id, created_at);

-- Admin › Vendors & map. Configuration: the seed does not truncate it —
-- which is why updated_by is a plain uuid and not a foreign key (the seed's
-- TRUNCATE principal … CASCADE would empty this table with it).
CREATE TABLE vendor_setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO vendor_setting (key, value) VALUES
  ('map_radius_miles',        '100'::jsonb),    -- how far from the work order the map looks
  ('map_daily_alert',         '100'::jsonb),    -- map opens per person per day before an alert is raised
  ('hire_warn_compliance',    'true'::jsonb);   -- warn (never block) when hiring with a missing / expired COI

-- ── Who may do what ──────────────────────────────────────────────────────────
-- Only fills a path the role has not set, so a Roles-screen decision survives
-- a re-run.

-- The Vendors section. The module was not live before this migration, and
-- 0021 left a placeholder {view: true} on every role — not a decision anybody
-- made — so the grant is written outright here: managers, admin and the VR
-- Officer work the section in full; everyone else starts without it
-- (dispatchers meet vendors on the map).
UPDATE role SET permissions = permissions
    || jsonb_build_object('vendors', jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', code = 'admin'))
 WHERE code IN ('admin', 'tl', 'atl', 'am', 'vr_officer');
UPDATE role SET permissions = permissions
    || jsonb_build_object('vendors', jsonb_build_object('view', false, 'create', false, 'edit', false, 'delete', false))
 WHERE code NOT IN ('admin', 'tl', 'atl', 'am', 'vr_officer');

-- Notes and the blacklist: whoever works the map may add a note and
-- blacklist; clearing one is for managers.
UPDATE role SET permissions = permissions
    || jsonb_build_object('vendors/blacklist', jsonb_build_object('create', true, 'edit', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am') AND NOT (permissions ? 'vendors/blacklist');
UPDATE role SET permissions = permissions
    || jsonb_build_object('vendors/blacklist', jsonb_build_object('create', true, 'edit', false))
 WHERE code IN ('om', 'om_probation', 'senior_om', 'ops_coord', 'oa', 'vr_officer') AND NOT (permissions ? 'vendors/blacklist');

-- The map on a work order. Managers and admin see everything. The dispatcher
-- tiers start the way Tech Locator's "Dispatcher" did: the VR team's vendors
-- and their own technicians, no statewide / nationwide / subcontractors, and
-- they may add a technician.
UPDATE role SET permissions = permissions
    || jsonb_build_object('vendor_map', jsonb_build_object('view', true, 'create', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am', 'om', 'om_probation', 'senior_om', 'ops_coord', 'oa', 'vr_officer')
   AND NOT (permissions ? 'vendor_map');
UPDATE role SET permissions = permissions
    || jsonb_build_object('vendor_map', jsonb_build_object('view', false, 'create', false))
 WHERE code NOT IN ('admin', 'tl', 'atl', 'am', 'om', 'om_probation', 'senior_om', 'ops_coord', 'oa', 'vr_officer')
   AND NOT (permissions ? 'vendor_map');
UPDATE role SET permissions = permissions
    || jsonb_build_object(
         'vendor_map/techs',          jsonb_build_object('view', false),
         'vendor_map/statewide',      jsonb_build_object('view', false),
         'vendor_map/nationwide',     jsonb_build_object('view', false),
         'vendor_map/subcontractors', jsonb_build_object('view', false))
 WHERE code IN ('om', 'om_probation', 'senior_om', 'ops_coord', 'oa')
   AND NOT (permissions ? 'vendor_map/techs');

-- Admin › Vendors & map.
UPDATE role SET permissions = permissions
    || jsonb_build_object('admin/vendors', jsonb_build_object('view', true, 'edit', true))
 WHERE code = 'admin' AND NOT (permissions ? 'admin/vendors');
