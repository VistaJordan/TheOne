-- 0063 · "Add work order", the rest of Facilio's create form.
--
-- The form itself has existed since 0041 (which fields it shows is
-- field_def.create_mode, set in Admin › Custom fields). This adds what it was
-- missing:
--   · four fields — Problem Type, Sub Category, Supplier Type, Work Permit
--     Needed — on the form by default;
--   · the sub-categories each trade offers (a trade IS our category);
--   · saved form templates.
-- Picking the site and the asset on the form needs no schema: task.site_id
-- and task.asset_id have existed since 0008.
--
-- field_def rows are seed-owned (0011's data note): seed.ts declares the same
-- four rows in CURATED_FIELDS and switches them onto the form through
-- WO_CREATE_DEFAULT_KEYS. These INSERTs are for an already-seeded database.
-- KEEP THE FIELDS IN STEP.

INSERT INTO field_def (container_id, key, label, type, type_config, position)
SELECT c.id, v.key, v.label, v.type::field_type, v.type_config::jsonb,
       (SELECT COALESCE(max(position), 0) FROM field_def WHERE container_id = c.id) + v.ord
  FROM container c
  CROSS JOIN (VALUES
    ('Problem Type', 'Problem Type', 'dropdown',
     '{"options":["Not working","Damaged","Leaking water","Leak inspection","Power loss","Electrical","Gas","Temperature","High temperature","Physical damage","Noise","Safety hazard","Other"]}', 1),
    ('Sub Category', 'Sub Category', 'short_text', '{}', 2),
    ('Supplier Type', 'Supplier Type', 'dropdown', '{"options":["External supplier","Internal"]}', 3),
    ('Work Permit Needed', 'Work Permit Needed', 'checkbox', '{}', 4)
  ) AS v(key, label, type, type_config, ord)
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;

UPDATE field_def SET create_mode = 'optional'
 WHERE create_mode = 'off'
   AND key IN ('Problem Type', 'Sub Category', 'Supplier Type', 'Work Permit Needed');

-- ── Sub-categories ──────────────────────────────────────────────────────────
-- What a trade can be narrowed to. Configuration (edited in Admin › Settings),
-- not truncated by the seed, no FK — the 0012 reasoning. `trade` is matched to
-- the work order's Trade by name, case ignored.

CREATE TABLE wo_subcategory (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade     text NOT NULL,
  name      text NOT NULL,
  position  int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX wo_subcategory_key ON wo_subcategory (lower(trade), lower(name));

INSERT INTO wo_subcategory (trade, name, position) VALUES
  ('HVAC', 'No cooling', 0), ('HVAC', 'No heating', 1), ('HVAC', 'Thermostat', 2), ('HVAC', 'Air flow / ductwork', 3),
  ('HVAC', 'Rooftop unit', 4), ('HVAC', 'Exhaust / hood', 5), ('HVAC', 'Water leak / condensate', 6),
  ('Refrigeration', 'Walk-in cooler', 0), ('Refrigeration', 'Walk-in freezer', 1), ('Refrigeration', 'Reach-in', 2),
  ('Refrigeration', 'Ice machine', 3), ('Refrigeration', 'Display case', 4), ('Refrigeration', 'Not holding temperature', 5),
  ('Plumbing', 'Leak', 0), ('Plumbing', 'Clog / backup', 1), ('Plumbing', 'Toilet / urinal', 2), ('Plumbing', 'Faucet / sink', 3),
  ('Plumbing', 'Water heater', 4), ('Plumbing', 'Grease trap', 5), ('Plumbing', 'No water', 6),
  ('Electric', 'Power outage', 0), ('Electric', 'Lighting', 1), ('Electric', 'Outlet / switch', 2), ('Electric', 'Breaker / panel', 3),
  ('Electric', 'Signage', 4),
  ('Handyman', 'Doors', 0), ('Handyman', 'Walls / ceiling', 1), ('Handyman', 'Flooring', 2), ('Handyman', 'Fixtures', 3),
  ('Handyman', 'Painting', 4),
  ('Appliance', 'Oven / range', 0), ('Appliance', 'Fryer', 1), ('Appliance', 'Dishwasher', 2), ('Appliance', 'Beverage equipment', 3),
  ('Locksmith', 'Lockout', 0), ('Locksmith', 'Rekey', 1), ('Locksmith', 'Lock repair', 2),
  ('Overhead Door', 'Will not open or close', 0), ('Overhead Door', 'Off track', 1), ('Overhead Door', 'Opener', 2),
  ('Roofing', 'Leak', 0), ('Roofing', 'Damage', 1), ('Roofing', 'Gutter / drain', 2)
ON CONFLICT DO NOTHING;

-- ── Form templates ──────────────────────────────────────────────────────────
-- A named set of values that pre-fills the form: "7-Eleven refrigeration
-- call", "Emergency plumbing". `fields` holds only keys that were on the form
-- when it was saved; a key since switched off is simply not applied. A
-- template is its owner's unless shared. No FK to principal (0060 reasoning).

CREATE TABLE wo_create_template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  fields      jsonb NOT NULL DEFAULT '{}'::jsonb,
  site_id     uuid REFERENCES site(id) ON DELETE SET NULL,
  shared      boolean NOT NULL DEFAULT false,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wo_create_template_owner_idx ON wo_create_template (created_by);
CREATE TRIGGER wo_create_template_touch BEFORE UPDATE ON wo_create_template
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
