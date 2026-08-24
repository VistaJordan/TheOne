-- 0008 — sites and assets as first-class records.
--
-- WHY NOW, not at R2: every Ecotrak work order already carries a `location`
-- object and an `asset` object, both with stable vendor IDs, at 100% coverage.
-- Today the location is flattened to two text columns and the asset is reduced
-- to a single string in the custom-field bag. Retrofitting this after 21,000
-- work orders is a migration under production load; doing it now is two tables.
--
-- SCOPE: `client` stays TEXT here rather than a foreign key. Promoting client,
-- FM company and billing entity to entities is the portfolio module and is a
-- separate piece of work — this migration only models the data that is already
-- arriving, so it does not pull the whole module forward.

-- ── Sites — a physical location where work happens ─────────────────────────
CREATE TABLE site (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Vendor identity. Ecotrak's location.id is stable and is the dedupe key.
  external_source text NOT NULL,
  external_id     text NOT NULL,
  client          text,                    -- promotes to a FK with the portfolio module
  name            text,                    -- e.g. "Wendy's 1234"
  store_number    text,                    -- 100% populated by Ecotrak
  address1        text,
  address2        text,
  city            text,
  state           text,                    -- stored AS SENT; abbreviation is a display concern
  zip             text,
  phone_1         text,
  phone_1_ext     text,
  phone_2         text,
  phone_2_ext     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (external_source, external_id)
);
CREATE INDEX site_client_idx ON site(client);
CREATE INDEX site_store_idx  ON site(store_number);
CREATE INDEX site_state_idx  ON site(state);
CREATE TRIGGER site_touch BEFORE UPDATE ON site
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Assets — the equipment a work order is raised against ──────────────────
CREATE TABLE asset (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_source text NOT NULL,
  external_id     text NOT NULL,
  -- Where the asset lives. Inferred from the work order that referenced it;
  -- an asset seen at a second site would be a data conflict worth surfacing,
  -- so this is set on first sight and not silently overwritten.
  site_id         uuid REFERENCES site(id),
  name            text NOT NULL,           -- e.g. "Doors", "SPLIT HVAC SYSTEMS"
  asset_type      text,                    -- Ecotrak asset_type_name
  model_number    text,                    -- only 26% populated
  description     text,
  alt_description text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (external_source, external_id)
);
CREATE INDEX asset_site_idx ON asset(site_id);
CREATE INDEX asset_name_idx ON asset(name);
CREATE TRIGGER asset_touch BEFORE UPDATE ON asset
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Work orders point at both ──────────────────────────────────────────────
ALTER TABLE task ADD COLUMN site_id  uuid REFERENCES site(id);
ALTER TABLE task ADD COLUMN asset_id uuid REFERENCES asset(id);
CREATE INDEX task_site_idx  ON task(site_id);
CREATE INDEX task_asset_idx ON task(asset_id);

-- ══ BACKFILL from the raw landing zone ═════════════════════════════════════
-- No Ecotrak call is needed: cmms_event_raw holds every payload verbatim, which
-- is precisely why it stores the raw JSON rather than only the mapped result.
-- 469 raw rows cover 232 work orders, 163 distinct sites and 220 assets.

-- Latest payload per location wins, so a site that was renamed or re-addressed
-- lands with its most recent details.
INSERT INTO site (
  external_source, external_id, client, name, store_number,
  address1, address2, city, state, zip, phone_1, phone_1_ext, phone_2, phone_2_ext
)
SELECT DISTINCT ON (e.payload->'location'->>'id')
  'ecotrak',
  e.payload->'location'->>'id',
  e.payload->'customer'->>'customer_name',
  e.payload->'location'->>'name',
  e.payload->'location'->>'store_number',
  e.payload->'location'->>'address1',
  e.payload->'location'->>'address2',
  e.payload->'location'->>'city',
  e.payload->'location'->>'state',
  e.payload->'location'->>'zip',
  e.payload->'location'->>'phone_1',
  e.payload->'location'->>'phone_1_ext',
  e.payload->'location'->>'phone_2',
  e.payload->'location'->>'phone_2_ext'
FROM cmms_event_raw e
WHERE e.payload->'location'->>'id' IS NOT NULL
ORDER BY e.payload->'location'->>'id', e.received_at DESC
ON CONFLICT (external_source, external_id) DO NOTHING;

INSERT INTO asset (
  external_source, external_id, site_id, name, asset_type,
  model_number, description, alt_description
)
SELECT DISTINCT ON (e.payload->'asset'->>'id')
  'ecotrak',
  e.payload->'asset'->>'id',
  s.id,
  COALESCE(NULLIF(e.payload->'asset'->>'name', ''), 'Unnamed asset'),
  e.payload->>'asset_type_name',
  NULLIF(e.payload->'asset'->>'model_number', ''),
  NULLIF(e.payload->'asset'->>'description', ''),
  NULLIF(e.payload->'asset'->>'alt_description', '')
FROM cmms_event_raw e
LEFT JOIN site s
  ON s.external_source = 'ecotrak'
 AND s.external_id = e.payload->'location'->>'id'
WHERE e.payload->'asset'->>'id' IS NOT NULL
ORDER BY e.payload->'asset'->>'id', e.received_at DESC
ON CONFLICT (external_source, external_id) DO NOTHING;

-- Link the work orders. DISTINCT ON keeps one raw row per work order, so the
-- 469-to-232 fan-out cannot multiply the update.
WITH latest AS (
  SELECT DISTINCT ON (l.task_id)
    l.task_id,
    e.payload->'location'->>'id' AS loc_ext,
    e.payload->'asset'->>'id'    AS asset_ext
  FROM cmms_wo_link l
  JOIN cmms_event_raw e
    ON e.connection_id = l.connection_id
   AND e.external_id   = l.external_id
  ORDER BY l.task_id, e.received_at DESC
)
UPDATE task t
   SET site_id  = s.id,
       asset_id = a.id
  FROM latest x
  LEFT JOIN site  s ON s.external_source = 'ecotrak' AND s.external_id = x.loc_ext
  LEFT JOIN asset a ON a.external_source = 'ecotrak' AND a.external_id = x.asset_ext
 WHERE t.id = x.task_id;
