-- 0060 · Portfolio: sites, their buildings / floors / spaces, and assets.
--
-- `site` and `asset` have existed since 0008, filled only by the Ecotrak
-- sync and read by nothing but a join or two. This makes them records people
-- open and keep: a site gets its type, who manages it, a geofence and a place
-- on the map; under it sit buildings, floors and spaces; an asset gets its
-- category, serial, warranty, parent, where it stands and what state it is in,
-- with a log of every condition reading.
--
-- What the Ecotrak sync writes on a site (client, name, store number, address)
-- it keeps writing on every sighting — those columns stay Ecotrak's for a site
-- that came from Ecotrak. Every column added here is ours and the sync never
-- touches it. The sync file is not edited.
--
-- A record made by hand carries external_source = 'manual' and its own id as
-- external_id, so the (source, id) uniqueness the sync dedupes on still holds.
--
-- No foreign key points at `principal` from here: the local seed TRUNCATEs
-- principal … CASCADE, which would empty every table that references it.
-- Sites and assets are not sample data and must survive a re-seed (the 0012
-- reasoning), so the people columns are plain uuids.

-- ── Sites ───────────────────────────────────────────────────────────────────

ALTER TABLE site
  ADD COLUMN site_type        text,
  ADD COLUMN ownership_status text,
  ADD COLUMN managed_by       uuid,
  ADD COLUMN billing_entity   text,
  ADD COLUMN contact_name     text,
  ADD COLUMN contact_email    text,
  ADD COLUMN hours            text,
  ADD COLUMN access_notes     text,
  ADD COLUMN notes            text,
  -- The geofence: how far from the pin still counts as "on site", in feet.
  ADD COLUMN boundary_radius_ft int CHECK (boundary_radius_ft IS NULL OR boundary_radius_ft BETWEEN 50 AND 26400),
  ADD COLUMN lat              double precision,
  ADD COLUMN lng              double precision,
  -- zip = placed from the ZIP table (0056); city = from the city table;
  -- manual = a person typed the coordinates, and saving the address again
  -- does not move the pin.
  ADD COLUMN geo_source       text CHECK (geo_source IS NULL OR geo_source IN ('zip', 'city', 'manual')),
  ADD COLUMN is_active        boolean NOT NULL DEFAULT true,
  ADD COLUMN created_by       uuid,
  ADD COLUMN deleted_at       timestamptz;

CREATE INDEX site_live_idx ON site (lower(name)) WHERE deleted_at IS NULL;

-- Place what is already on file. A site whose ZIP is unknown falls back to
-- its city; one with neither stays off the map until somebody corrects it.
UPDATE site s
   SET lat = z.lat, lng = z.lng, geo_source = 'zip'
  FROM geo_zip z
 WHERE s.lat IS NULL AND z.zip = substring(btrim(s.zip) from '^[0-9]{5}');

-- The lists a site is filed under. Configuration, edited in the Sites page's
-- settings; no FK, so a value in use can be switched off without a cascade.
CREATE TABLE site_type (
  name      text PRIMARY KEY,
  position  int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);
INSERT INTO site_type (name, position) VALUES
  ('Restaurant', 0), ('Retail store', 1), ('Convenience store', 2), ('Grocery', 3),
  ('Office', 4), ('Warehouse', 5), ('Medical', 6), ('Bank branch', 7), ('Other', 8);

-- ── Buildings, floors, spaces ───────────────────────────────────────────────
-- One table, three kinds, nested by parent: a building sits on the site, a
-- floor in a building, a space on a floor (or straight in a building, or on
-- the site itself — a drive-through lane belongs to no building). The service
-- enforces what may sit under what; the row only knows its parent.

CREATE TABLE site_location (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES site_location(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('building', 'floor', 'space')),
  name        text NOT NULL,
  -- floor: its level (0 = ground, -1 = basement). space: what it is.
  level       int,
  space_type  text,
  area_sqft   numeric(12,2) CHECK (area_sqft IS NULL OR area_sqft >= 0),
  notes       text,
  position    int NOT NULL DEFAULT 0,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_location_site_idx   ON site_location (site_id);
CREATE INDEX site_location_parent_idx ON site_location (parent_id);
CREATE TRIGGER site_location_touch BEFORE UPDATE ON site_location
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Assets ──────────────────────────────────────────────────────────────────

ALTER TABLE asset
  ADD COLUMN category             text,
  ADD COLUMN manufacturer         text,
  ADD COLUMN serial_number        text,
  ADD COLUMN asset_tag            text,
  ADD COLUMN install_date         date,
  ADD COLUMN warranty_expires_on  date,
  ADD COLUMN warranty_provider    text,
  ADD COLUMN warranty_notes       text,
  ADD COLUMN parent_asset_id      uuid REFERENCES asset(id) ON DELETE SET NULL,
  ADD COLUMN location_id          uuid REFERENCES site_location(id) ON DELETE SET NULL,
  ADD COLUMN status               text NOT NULL DEFAULT 'in_service'
    CHECK (status IN ('in_service', 'out_of_service', 'retired')),
  ADD COLUMN condition            text
    CHECK (condition IS NULL OR condition IN ('good', 'fair', 'poor', 'critical')),
  ADD COLUMN condition_at         timestamptz,
  ADD COLUMN notes                text,
  ADD COLUMN created_by           uuid,
  ADD COLUMN deleted_at           timestamptz;

CREATE INDEX asset_parent_idx   ON asset (parent_asset_id);
CREATE INDEX asset_location_idx ON asset (location_id);
CREATE INDEX asset_warranty_idx ON asset (warranty_expires_on) WHERE deleted_at IS NULL;

-- Every condition reading, newest last. asset.condition is the latest one.
CREATE TABLE asset_condition_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  condition   text NOT NULL CHECK (condition IN ('good', 'fair', 'poor', 'critical')),
  note        text,
  -- The work order the reading was taken on, when there was one. No FK: the
  -- seed truncates task … CASCADE and the log must outlive it.
  task_id     uuid,
  recorded_by uuid,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_condition_asset_idx ON asset_condition_log (asset_id, recorded_at);

CREATE TABLE asset_category (
  name      text PRIMARY KEY,
  position  int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);
INSERT INTO asset_category (name, position) VALUES
  ('HVAC', 0), ('Refrigeration', 1), ('Kitchen equipment', 2), ('Plumbing', 3),
  ('Electrical', 4), ('Doors and locks', 5), ('Lighting', 6), ('Fire and safety', 7),
  ('Signage', 8), ('Building', 9), ('Other', 10);

-- ── Who may do what ─────────────────────────────────────────────────────────
-- Everyone who works work orders may look a site or an asset up. Keeping the
-- records is for the people who run the accounts; removing one is a
-- manager's act. Guarded so a role somebody already tuned is left alone.

UPDATE role SET permissions = permissions
    || jsonb_build_object('sites',  jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true),
                          'assets', jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am') AND NOT (permissions ? 'sites');

UPDATE role SET permissions = permissions
    || jsonb_build_object('sites',  jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', false),
                          'assets', jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', false))
 WHERE code IN ('om', 'om_probation', 'senior_om', 'ops_coord', 'oa') AND NOT (permissions ? 'sites');

UPDATE role SET permissions = permissions
    || jsonb_build_object('sites',  jsonb_build_object('view', true, 'create', false, 'edit', false, 'delete', false),
                          'assets', jsonb_build_object('view', true, 'create', false, 'edit', false, 'delete', false))
 WHERE code NOT IN ('admin', 'tl', 'atl', 'am', 'om', 'om_probation', 'senior_om', 'ops_coord', 'oa')
   AND NOT (permissions ? 'sites');
