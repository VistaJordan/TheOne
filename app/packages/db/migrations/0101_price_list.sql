-- 0101 · The price list (Elise, 2026-10-27). Vocabulary and the pure lookup:
-- packages/shared/src/prices.ts. The API: services/prices.ts, routes/
-- prices.ts; the page is Prices in the sidebar (/prices).
--
-- What the team charges, per billing entity (Comp), per client and per
-- trade, as the "Prices & quotes library" sheet kept it (its five Price List
-- tabs; the Quote Library and Quote Archive tabs are not prices and were not
-- loaded). One CARD per (entity, client): the entity's Standard card has no
-- client, every other card names one. A card carries the trip charge and the
-- materials markup ("up to ×1.3", stored as the multiplier 1.3), its labor
-- RATES (one row per line of the sheet: a label as the sheet wrote it, e.g.
-- "Plumber - Electrician", the work-order Trade values it prices, and tech /
-- helper / after-hours / holiday per hour, plus a trip of its own where the
-- sheet gave one per trade — AF / All Systems) and its FEES (snake, hydrojet,
-- boom lift …: a figure, or a note when the sheet gave a range or a unit —
-- "$350-550", "$250 per device").
--
-- A client card states only what differs: a trade it does not list, and a
-- trip it leaves blank, are the entity's Standard card's (`resolvePrice`).
-- The quote builder's rate card (`findLaborRate`, services/rates.ts) now
-- reads this list first, so a new quote's Trip line opens at the card's trip.
--
-- Clients are text, matched like everywhere else (lower(btrim(name))), with
-- no FK: the list keeps a card for a client that has no client record yet
-- (the page flags it). Sheet names were written in the client records'
-- spelling where one is on file: Powerhouse = PH, LASER = Laser, RSM = RSM
-- LEO, Outback Steakhouse = "Outback Staekhouse" (the record's spelling),
-- SUN HOLDING / RMH = one card each for Sun Holdings and RMH, Green Thumb
-- Industries = Green Thumb. SFM's "MOD Pizza Snake fee" is a MOD Pizza card
-- holding that one fee. Where a card names a trade twice (BKR / Pet
-- Supermarket: "Handyman - Locksmith - Doors - Glass" and "Locksmith") the
-- row of its own wins.
--
-- No FK to principal (updated_by is a plain uuid) and the seed truncates none
-- of the three tables, so the list survives a re-seed (the client_team
-- reasoning, 0096). Nothing here needs a seed twin.
--
-- Permission path `prices` (view / create / edit / delete): the admin role
-- holds all four; every role that can view quotes may view the list. Only
-- where the path is not already set, so a Roles-screen decision survives.

CREATE TABLE price_card (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_entity   text NOT NULL CHECK (btrim(billing_entity) <> ''),
  client           text CHECK (client IS NULL OR btrim(client) <> ''),
  trip_rate        numeric(12,2) CHECK (trip_rate IS NULL OR trip_rate >= 0),
  materials_markup numeric(6,3) CHECK (materials_markup IS NULL OR materials_markup >= 1),
  note             text,
  position         integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid
);
CREATE UNIQUE INDEX price_card_one_per_client
  ON price_card (upper(btrim(billing_entity)), lower(btrim(COALESCE(client, ''))));
CREATE TRIGGER price_card_touch BEFORE UPDATE ON price_card
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE price_rate (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id         uuid NOT NULL REFERENCES price_card(id) ON DELETE CASCADE,
  position        integer NOT NULL DEFAULT 0,
  label           text NOT NULL CHECK (btrim(label) <> ''),
  trades          text[] NOT NULL DEFAULT '{}',
  tech_rate       numeric(12,2) CHECK (tech_rate IS NULL OR tech_rate >= 0),
  helper_rate     numeric(12,2) CHECK (helper_rate IS NULL OR helper_rate >= 0),
  afterhours_rate numeric(12,2) CHECK (afterhours_rate IS NULL OR afterhours_rate >= 0),
  holiday_rate    numeric(12,2) CHECK (holiday_rate IS NULL OR holiday_rate >= 0),
  trip_rate       numeric(12,2) CHECK (trip_rate IS NULL OR trip_rate >= 0)
);
CREATE INDEX price_rate_card_idx ON price_rate (card_id, position);

CREATE TABLE price_fee (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id  uuid NOT NULL REFERENCES price_card(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  name     text NOT NULL CHECK (btrim(name) <> ''),
  amount   numeric(12,2) CHECK (amount IS NULL OR amount >= 0),
  note     text
);
CREATE INDEX price_fee_card_idx ON price_fee (card_id, position);

UPDATE role
   SET permissions = permissions
     || jsonb_build_object('prices', jsonb_build_object(
          'view', true, 'create', true, 'edit', true, 'delete', true))
 WHERE code = 'admin'
   AND NOT (permissions ? 'prices');

UPDATE role
   SET permissions = permissions
     || jsonb_build_object('prices', jsonb_build_object('view', true))
 WHERE code <> 'admin'
   AND (permissions -> 'quotes' ->> 'view') = 'true'
   AND NOT (permissions ? 'prices');

-- The sheet, card by card (generated from the workbook, ids stable).
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 'SFM', NULL, 75.00, 1.30, NULL, 0);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 0, 'Handyman', ARRAY['Handyman']::text[], 89.00, NULL, 133.50, 178.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 1, 'Locksmith', ARRAY['Locksmith']::text[], 89.00, NULL, 133.50, 178.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 2, 'Plumber', ARRAY['Plumbing']::text[], 99.00, NULL, 148.50, 198.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 3, 'Electrician', ARRAY['Electric']::text[], 99.00, NULL, 148.50, 198.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 4, 'HVAC-R', ARRAY['HVAC', 'Refrigeration']::text[], 129.00, NULL, 193.50, 258.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 5, 'Appliance', ARRAY['Appliance']::text[], 129.00, NULL, 193.50, 258.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 1, 'Hydrojet', 450.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 2, 'Crane', 1200.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 3, 'Camera', 450.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 4, 'Dehumidifier', 150.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 5, 'Jetter', 450.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 6, 'Dumpster Truck', 650.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 7, 'Jackhammer', 175.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 8, 'Backflow', NULL, '$250 per device');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 9, 'Welding', 150.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 10, 'Septic Truck', 1200.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 11, 'Boomlift', NULL, '$650-1500 per day');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 12, 'Leak test', NULL, '$50-150');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('fae11806-1765-5ee8-9a62-dc0b51b01059', 13, 'Scissor lift', NULL, '$650(19ft), $800(26ft), $1,000(32ft), $1,500 (50ft)');
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('48f7da89-64e4-5ba9-ae4b-7786b9580c18', 'SFM', 'MOD Pizza', NULL, NULL, NULL, 1);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('48f7da89-64e4-5ba9-ae4b-7786b9580c18', 0, 'Snake', 160.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('db59da0f-486f-5be4-ab1c-b8d98a5c665d', 'SFM', 'Riser Fitness', 75.00, 1.30, NULL, 2);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('db59da0f-486f-5be4-ab1c-b8d98a5c665d', 0, 'Handyman', ARRAY['Handyman']::text[], 96.00, NULL, 96.00, 96.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('db59da0f-486f-5be4-ab1c-b8d98a5c665d', 1, 'Locksmith', ARRAY['Locksmith']::text[], 107.00, NULL, 107.00, 107.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('db59da0f-486f-5be4-ab1c-b8d98a5c665d', 2, 'Plumber', ARRAY['Plumbing']::text[], 119.00, NULL, 119.00, 119.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('db59da0f-486f-5be4-ab1c-b8d98a5c665d', 3, 'Electrician', ARRAY['Electric']::text[], 119.00, NULL, 119.00, 119.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('db59da0f-486f-5be4-ab1c-b8d98a5c665d', 4, 'HVAC-R', ARRAY['HVAC', 'Refrigeration']::text[], 155.00, NULL, 155.00, 155.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('db59da0f-486f-5be4-ab1c-b8d98a5c665d', 5, 'Appliance', ARRAY['Appliance']::text[], 155.00, NULL, 155.00, 155.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('db59da0f-486f-5be4-ab1c-b8d98a5c665d', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('db59da0f-486f-5be4-ab1c-b8d98a5c665d', 1, 'Hydrojet', 450.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('92a64397-c52d-5645-84e1-849a91303dfa', 'SFM', 'Sun Holdings', 0.00, 1.30, NULL, 3);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('92a64397-c52d-5645-84e1-849a91303dfa', 0, 'Handyman', ARRAY['Handyman']::text[], 89.00, NULL, 89.00, 89.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('92a64397-c52d-5645-84e1-849a91303dfa', 1, 'Locksmith', ARRAY['Locksmith']::text[], 89.00, NULL, 89.00, 89.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('92a64397-c52d-5645-84e1-849a91303dfa', 2, 'Plumber', ARRAY['Plumbing']::text[], 99.00, NULL, 99.00, 99.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('92a64397-c52d-5645-84e1-849a91303dfa', 3, 'Electrician', ARRAY['Electric']::text[], 99.00, NULL, 99.00, 99.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('92a64397-c52d-5645-84e1-849a91303dfa', 4, 'HVAC-R', ARRAY['HVAC', 'Refrigeration']::text[], 100.00, NULL, 100.00, 100.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('92a64397-c52d-5645-84e1-849a91303dfa', 5, 'Appliance', ARRAY['Appliance']::text[], 100.00, NULL, 100.00, 100.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('92a64397-c52d-5645-84e1-849a91303dfa', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('92a64397-c52d-5645-84e1-849a91303dfa', 1, 'Hydrojet', 450.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('29e811a5-4fa6-57e8-beaa-647963cbecbc', 'SFM', 'RMH', 0.00, 1.30, NULL, 4);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('29e811a5-4fa6-57e8-beaa-647963cbecbc', 0, 'Handyman', ARRAY['Handyman']::text[], 89.00, NULL, 89.00, 89.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('29e811a5-4fa6-57e8-beaa-647963cbecbc', 1, 'Locksmith', ARRAY['Locksmith']::text[], 89.00, NULL, 89.00, 89.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('29e811a5-4fa6-57e8-beaa-647963cbecbc', 2, 'Plumber', ARRAY['Plumbing']::text[], 99.00, NULL, 99.00, 99.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('29e811a5-4fa6-57e8-beaa-647963cbecbc', 3, 'Electrician', ARRAY['Electric']::text[], 99.00, NULL, 99.00, 99.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('29e811a5-4fa6-57e8-beaa-647963cbecbc', 4, 'HVAC-R', ARRAY['HVAC', 'Refrigeration']::text[], 100.00, NULL, 100.00, 100.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('29e811a5-4fa6-57e8-beaa-647963cbecbc', 5, 'Appliance', ARRAY['Appliance']::text[], 100.00, NULL, 100.00, 100.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('29e811a5-4fa6-57e8-beaa-647963cbecbc', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('29e811a5-4fa6-57e8-beaa-647963cbecbc', 1, 'Hydrojet', 450.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('b372c0f2-0329-5d23-8f37-738c6a7d3bef', 'SFM', 'Green Thumb', 75.00, 1.30, NULL, 5);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('b372c0f2-0329-5d23-8f37-738c6a7d3bef', 0, 'Handyman', ARRAY['Handyman']::text[], 99.00, NULL, 148.50, 198.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('b372c0f2-0329-5d23-8f37-738c6a7d3bef', 1, 'Locksmith', ARRAY['Locksmith']::text[], 99.00, NULL, 148.50, 198.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('b372c0f2-0329-5d23-8f37-738c6a7d3bef', 2, 'Plumber', ARRAY['Plumbing']::text[], 109.00, NULL, 163.50, 218.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('b372c0f2-0329-5d23-8f37-738c6a7d3bef', 3, 'Electrician', ARRAY['Electric']::text[], 109.00, NULL, 163.50, 218.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('b372c0f2-0329-5d23-8f37-738c6a7d3bef', 4, 'HVAC-R', ARRAY['HVAC', 'Refrigeration']::text[], 139.00, NULL, 208.50, 278.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('b372c0f2-0329-5d23-8f37-738c6a7d3bef', 5, 'Appliance', ARRAY['Appliance']::text[], 139.00, NULL, 208.50, 278.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('b372c0f2-0329-5d23-8f37-738c6a7d3bef', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('b372c0f2-0329-5d23-8f37-738c6a7d3bef', 1, 'Hydrojet', 450.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 'BKR', NULL, 50.00, 1.30, NULL, 0);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 0, 'Handyman (default rate, incl. carpentry, tilework, etc.)', ARRAY['Handyman']::text[], 80.00, 70.00, 120.00, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 1, 'Plumber - Electrician', ARRAY['Plumbing', 'Electric']::text[], 90.00, 80.00, 135.00, 180.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 2, 'HVAC/R - Appliances', ARRAY['HVAC', 'Refrigeration', 'Appliance']::text[], 120.00, 100.00, 180.00, 240.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 3, 'Janitorial', ARRAY['Janitorial']::text[], 45.00, NULL, NULL, NULL, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 1, 'Bucket truck', 300.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 2, 'Camera', NULL, '$350-550');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 3, 'Dehumidifier', NULL, '$150-450');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 4, 'Jetter', NULL, '$350-550');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 5, 'Generator', NULL, '$300-12,000 per day');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 6, 'Jackhammer', 175.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 7, 'Backflow', NULL, '$250 per device');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 8, 'Welding', NULL, '$50-300');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 9, 'Septic Truck', 1200.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 10, 'Boomlift', NULL, '$650-1500 per day');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 11, 'Leak test', 150.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('d11cc4bc-1c8e-5a3b-9c37-5521365025b3', 12, 'Scissor lift', NULL, '$650(19ft), $800(26ft), $1,000(32ft), $1,500 (50ft)');
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('53c9a948-b1ca-52ce-9aeb-21c24ce10c1c', 'BKR', 'EMCOR', 75.00, 1.30, 'After-hours rates start at 5pm.', 1);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('53c9a948-b1ca-52ce-9aeb-21c24ce10c1c', 0, 'Handyman - Locksmith - Doors - Glass', ARRAY['Handyman', 'Locksmith']::text[], 75.00, NULL, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('53c9a948-b1ca-52ce-9aeb-21c24ce10c1c', 1, 'Plumber - Electrician', ARRAY['Plumbing', 'Electric']::text[], 75.00, NULL, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('53c9a948-b1ca-52ce-9aeb-21c24ce10c1c', 2, 'Janitorial', ARRAY['Janitorial']::text[], 75.00, NULL, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('53c9a948-b1ca-52ce-9aeb-21c24ce10c1c', 3, 'OVH/Gates', ARRAY['Overhead Door']::text[], 90.00, NULL, 135.00, 180.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('53c9a948-b1ca-52ce-9aeb-21c24ce10c1c', 4, 'HVAC/R - Appliances', ARRAY['HVAC', 'Refrigeration', 'Appliance']::text[], 90.00, NULL, 135.00, 180.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('53c9a948-b1ca-52ce-9aeb-21c24ce10c1c', 0, 'Snake', 200.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('53c9a948-b1ca-52ce-9aeb-21c24ce10c1c', 1, 'Hydrojet', 400.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('6184a19d-4c36-5f50-9750-957dcf0f7474', 'BKR', 'PH', 55.00, 1.30, NULL, 2);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('6184a19d-4c36-5f50-9750-957dcf0f7474', 0, 'Handyman', ARRAY['Handyman']::text[], 85.00, 80.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('6184a19d-4c36-5f50-9750-957dcf0f7474', 1, 'Plumber', ARRAY['Plumbing']::text[], 90.00, 85.00, 135.00, 180.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('6184a19d-4c36-5f50-9750-957dcf0f7474', 2, 'Electrician', ARRAY['Electric']::text[], 90.00, 85.00, 135.00, 180.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('6184a19d-4c36-5f50-9750-957dcf0f7474', 3, 'HVAC/R - Appliances', ARRAY['HVAC', 'Refrigeration', 'Appliance']::text[], 100.00, 90.00, 150.00, 200.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('6184a19d-4c36-5f50-9750-957dcf0f7474', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('6184a19d-4c36-5f50-9750-957dcf0f7474', 1, 'Hydrojet', 400.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('accafc1e-f33b-5caf-9383-abb823d9a908', 'BKR', 'Ed Shelman', 75.00, 1.30, 'After-hours rates start at 5pm.', 3);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('accafc1e-f33b-5caf-9383-abb823d9a908', 0, 'Handyman - Locksmith - Doors - Glass', ARRAY['Handyman', 'Locksmith']::text[], 85.00, 80.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('accafc1e-f33b-5caf-9383-abb823d9a908', 1, 'Plumber - Electrician', ARRAY['Plumbing', 'Electric']::text[], 85.00, 80.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('accafc1e-f33b-5caf-9383-abb823d9a908', 2, 'Janitorial', ARRAY['Janitorial']::text[], 85.00, 80.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('accafc1e-f33b-5caf-9383-abb823d9a908', 3, 'OVH/Gates', ARRAY['Overhead Door']::text[], 85.00, 80.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('accafc1e-f33b-5caf-9383-abb823d9a908', 4, 'HVAC/R - Appliances', ARRAY['HVAC', 'Refrigeration', 'Appliance']::text[], 105.00, 90.00, 157.50, 210.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('accafc1e-f33b-5caf-9383-abb823d9a908', 0, 'Snake', 200.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('accafc1e-f33b-5caf-9383-abb823d9a908', 1, 'Hydrojet', 400.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('5bc8ed53-e741-5417-bbc8-4b2bb04faf1d', 'BKR', 'Pet Supermarket', 75.00, 1.30, NULL, 4);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('5bc8ed53-e741-5417-bbc8-4b2bb04faf1d', 0, 'Handyman - Locksmith - Doors - Glass', ARRAY['Handyman']::text[], 85.00, NULL, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('5bc8ed53-e741-5417-bbc8-4b2bb04faf1d', 1, 'Plumber - Electrician', ARRAY['Plumbing', 'Electric']::text[], 85.00, NULL, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('5bc8ed53-e741-5417-bbc8-4b2bb04faf1d', 2, 'Janitorial', ARRAY['Janitorial']::text[], 85.00, NULL, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('5bc8ed53-e741-5417-bbc8-4b2bb04faf1d', 3, 'OVH/Gates', ARRAY['Overhead Door']::text[], 100.00, NULL, 150.00, 200.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('5bc8ed53-e741-5417-bbc8-4b2bb04faf1d', 4, 'HVAC/R - Appliances', ARRAY['HVAC', 'Refrigeration', 'Appliance']::text[], 100.00, NULL, 150.00, 200.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('5bc8ed53-e741-5417-bbc8-4b2bb04faf1d', 5, 'Locksmith', ARRAY['Locksmith']::text[], 85.00, NULL, 127.50, 170.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('5bc8ed53-e741-5417-bbc8-4b2bb04faf1d', 0, 'Snake', 200.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('5bc8ed53-e741-5417-bbc8-4b2bb04faf1d', 1, 'Hydrojet', 400.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('2aefb347-a5be-5138-8782-9222e6d81739', 'BKR', 'GRM', 75.00, 1.30, 'After-hours rates start at 5pm.', 5);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('2aefb347-a5be-5138-8782-9222e6d81739', 0, 'Handyman', ARRAY['Handyman']::text[], 75.00, NULL, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('2aefb347-a5be-5138-8782-9222e6d81739', 1, 'Plumber - Electrician', ARRAY['Plumbing', 'Electric']::text[], 75.00, NULL, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('2aefb347-a5be-5138-8782-9222e6d81739', 2, 'Janitorial', ARRAY['Janitorial']::text[], 75.00, NULL, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('2aefb347-a5be-5138-8782-9222e6d81739', 3, 'OVH/Gates', ARRAY['Overhead Door']::text[], 90.00, NULL, 135.00, 180.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('2aefb347-a5be-5138-8782-9222e6d81739', 4, 'HVAC/R - Appliances', ARRAY['HVAC', 'Refrigeration', 'Appliance']::text[], 90.00, NULL, 135.00, 180.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('2aefb347-a5be-5138-8782-9222e6d81739', 0, 'Snake', 200.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('2aefb347-a5be-5138-8782-9222e6d81739', 1, 'Hydrojet', 400.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('513f0914-5c09-56e3-8177-f5b7ed4f73b5', 'BKR', 'MaintainX', 60.00, 1.30, 'After-hours rates start at 5pm.', 6);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('513f0914-5c09-56e3-8177-f5b7ed4f73b5', 0, 'Handyman - Locksmith - Doors - Glass', ARRAY['Handyman', 'Locksmith']::text[], 85.00, 80.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('513f0914-5c09-56e3-8177-f5b7ed4f73b5', 1, 'Plumber - Electrician', ARRAY['Plumbing', 'Electric']::text[], 85.00, 80.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('513f0914-5c09-56e3-8177-f5b7ed4f73b5', 2, 'Janitorial', ARRAY['Janitorial']::text[], 85.00, 80.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('513f0914-5c09-56e3-8177-f5b7ed4f73b5', 3, 'HVAC/R - Appliances', ARRAY['HVAC', 'Refrigeration', 'Appliance']::text[], 85.00, 80.00, 127.50, 170.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('513f0914-5c09-56e3-8177-f5b7ed4f73b5', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('513f0914-5c09-56e3-8177-f5b7ed4f73b5', 1, 'Hydrojet', 400.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 'TPM', NULL, 67.00, 1.30, NULL, 0);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 0, 'Handyman (default rate, incl. carpentry, tilework, etc.)', ARRAY['Handyman']::text[], 83.00, 70.00, 124.50, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 1, 'Plumber - Electrician', ARRAY['Plumbing', 'Electric']::text[], 90.00, 80.00, 135.00, 180.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 2, 'HVAC - Appliances', ARRAY['HVAC', 'Appliance']::text[], 120.00, 100.00, 180.00, 240.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 3, 'Janitorial', ARRAY['Janitorial']::text[], 45.00, NULL, NULL, NULL, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 1, 'Bucket truck', 300.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 2, 'Camera', NULL, '$350-550');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 3, 'Dehumidifier', NULL, '$150-450');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 4, 'Jetter', NULL, '$350-550');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 5, 'Generator', NULL, '$300-12,000 per day');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 6, 'Jackhammer', 175.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 7, 'Backflow', NULL, '$250 per device');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 8, 'Welding', NULL, '$50-300');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 9, 'Septic Truck', 1200.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 10, 'Boomlift', NULL, '$650-1500 per day');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 11, 'Leak test', 150.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('09cc16e3-efa2-5533-b5f9-c6a20612d632', 12, 'Scissor lift', NULL, '$650(19ft), $800(26ft), $1,000(32ft), $1,500 (50ft)');
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('aef8396e-e841-5fca-a937-9cac70a5d217', 'TPM', 'KFM', 67.00, 1.30, 'After-hours rates start at 5pm.', 1);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('aef8396e-e841-5fca-a937-9cac70a5d217', 0, 'Handyman', ARRAY['Handyman']::text[], 78.00, NULL, 117.00, 156.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('aef8396e-e841-5fca-a937-9cac70a5d217', 1, 'Plumber', ARRAY['Plumbing']::text[], 83.00, NULL, 124.50, 166.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('aef8396e-e841-5fca-a937-9cac70a5d217', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('aef8396e-e841-5fca-a937-9cac70a5d217', 1, 'Hydrojet', 450.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('e90232fb-d762-5337-b732-2fe874512005', 'TPM', 'AFS', 67.00, 1.30, NULL, 2);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('e90232fb-d762-5337-b732-2fe874512005', 0, 'Handyman', ARRAY['Handyman']::text[], 78.00, NULL, 117.00, 156.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('e90232fb-d762-5337-b732-2fe874512005', 1, 'Plumber', ARRAY['Plumbing']::text[], 83.00, NULL, 124.50, 166.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('e90232fb-d762-5337-b732-2fe874512005', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('e90232fb-d762-5337-b732-2fe874512005', 1, 'Hydrojet', 450.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('802b8762-0340-54ea-b36a-037dd3212929', 'TPM', 'DAVACO', 67.00, 1.30, 'After-hours rates start at 5pm.', 3);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('802b8762-0340-54ea-b36a-037dd3212929', 0, 'Handyman', ARRAY['Handyman']::text[], 78.00, NULL, 117.00, 156.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('802b8762-0340-54ea-b36a-037dd3212929', 1, 'Plumber', ARRAY['Plumbing']::text[], 83.00, NULL, 124.50, 166.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('802b8762-0340-54ea-b36a-037dd3212929', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('802b8762-0340-54ea-b36a-037dd3212929', 1, 'Hydrojet', 450.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('806a30a2-dbef-59d4-9785-f3c7cedd7a6c', 'TPM', 'Laser', 67.00, 1.30, 'After-hours rates start at 5pm.', 4);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('806a30a2-dbef-59d4-9785-f3c7cedd7a6c', 0, 'Handyman', ARRAY['Handyman']::text[], 78.00, NULL, 117.00, 156.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('806a30a2-dbef-59d4-9785-f3c7cedd7a6c', 1, 'Plumber', ARRAY['Plumbing']::text[], 83.00, NULL, 124.50, 166.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('806a30a2-dbef-59d4-9785-f3c7cedd7a6c', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('806a30a2-dbef-59d4-9785-f3c7cedd7a6c', 1, 'Hydrojet', 450.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('806a30a2-dbef-59d4-9785-f3c7cedd7a6c', 2, 'Camera', 400.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('806a30a2-dbef-59d4-9785-f3c7cedd7a6c', 3, 'Hydrotruck', 1500.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('95a47994-6cac-573b-b21e-693335b9308b', 'TPM', 'RSM LEO', 67.00, 1.30, 'After-hours rates start at 5pm.', 5);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('95a47994-6cac-573b-b21e-693335b9308b', 0, 'Handyman', ARRAY['Handyman']::text[], 78.00, NULL, 117.00, 156.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('95a47994-6cac-573b-b21e-693335b9308b', 1, 'Plumber', ARRAY['Plumbing']::text[], 83.00, NULL, 124.50, 166.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('95a47994-6cac-573b-b21e-693335b9308b', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('95a47994-6cac-573b-b21e-693335b9308b', 1, 'Hydrojet', 450.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('e3c7a51f-2e62-576a-9e2f-8f5d8de6f7f4', 'TPM', 'Vixxo', 60.00, 1.30, 'After-hours rates start at 5pm.', 6);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('e3c7a51f-2e62-576a-9e2f-8f5d8de6f7f4', 0, 'Handyman', ARRAY['Handyman']::text[], 80.00, NULL, 120.00, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('e3c7a51f-2e62-576a-9e2f-8f5d8de6f7f4', 1, 'Plumber', ARRAY['Plumbing']::text[], 80.00, NULL, 120.00, 160.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('e3c7a51f-2e62-576a-9e2f-8f5d8de6f7f4', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('e3c7a51f-2e62-576a-9e2f-8f5d8de6f7f4', 1, 'Hydrojet', 450.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('9cb806bb-ff14-5f6a-a09a-1794d31e7626', 'TPM', 'ResQ', 67.00, 1.30, 'After-hours rates start at 5pm.', 7);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('9cb806bb-ff14-5f6a-a09a-1794d31e7626', 0, 'Handyman', ARRAY['Handyman']::text[], 78.00, NULL, 117.00, 156.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('9cb806bb-ff14-5f6a-a09a-1794d31e7626', 1, 'Plumber', ARRAY['Plumbing']::text[], 83.00, NULL, 124.50, 166.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('9cb806bb-ff14-5f6a-a09a-1794d31e7626', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('9cb806bb-ff14-5f6a-a09a-1794d31e7626', 1, 'Hydrojet', 450.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('becf2ab0-92f7-5cff-8dbc-17d8eec86098', 'TPM', 'PRS', 67.00, 1.30, 'After-hours rates start at 5pm.', 8);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('becf2ab0-92f7-5cff-8dbc-17d8eec86098', 0, 'Handyman', ARRAY['Handyman']::text[], 78.00, NULL, 117.00, 156.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('becf2ab0-92f7-5cff-8dbc-17d8eec86098', 1, 'Plumber', ARRAY['Plumbing']::text[], 83.00, NULL, 124.50, 166.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('becf2ab0-92f7-5cff-8dbc-17d8eec86098', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('becf2ab0-92f7-5cff-8dbc-17d8eec86098', 1, 'Hydrojet', 450.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 'AF', NULL, 65.00, 1.30, NULL, 0);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 0, 'Handyman (default rate, incl. carpentry, tilework, etc.)', ARRAY['Handyman']::text[], 80.00, 70.00, 120.00, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 1, 'Plumber - Electrician', ARRAY['Plumbing', 'Electric']::text[], 90.00, 80.00, 135.00, 180.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 2, 'HVAC - Appliances', ARRAY['HVAC', 'Appliance']::text[], 120.00, 100.00, 180.00, 240.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 3, 'Janitorial', ARRAY['Janitorial']::text[], 45.00, NULL, NULL, NULL, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 1, 'Bucket truck', 300.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 2, 'Camera', NULL, '$350-550');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 3, 'Dehumidifier', NULL, '$150-450');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 4, 'Jetter', NULL, '$350-550');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 5, 'Generator', NULL, '$300-12,000 per day');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 6, 'Jackhammer', 175.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 7, 'Backflow', NULL, '$250 per device');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 8, 'Welding', NULL, '$50-300');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 9, 'Septic Truck', 1200.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 10, 'Boomlift', NULL, '$650-1500 per day');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 11, 'Leak test', 150.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('5b271f2a-fc17-527d-8f08-521aebf1b299', 12, 'Scissor lift', NULL, '$650(19ft), $800(26ft), $1,000(32ft), $1,500 (50ft)');
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('2ab669fa-fc63-5138-9f16-0635835ef696', 'AF', 'BW', 55.00, 1.30, NULL, 1);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('2ab669fa-fc63-5138-9f16-0635835ef696', 0, 'Handyman', ARRAY['Handyman']::text[], 75.00, 65.00, 112.50, 140.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('2ab669fa-fc63-5138-9f16-0635835ef696', 1, 'Plumber', ARRAY['Plumbing']::text[], 85.00, 80.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('2ab669fa-fc63-5138-9f16-0635835ef696', 2, 'Electrician', ARRAY['Electric']::text[], 85.00, 80.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('2ab669fa-fc63-5138-9f16-0635835ef696', 3, 'Locksmith', ARRAY['Locksmith']::text[], 85.00, 80.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('2ab669fa-fc63-5138-9f16-0635835ef696', 4, 'OVH/Gates', ARRAY['Overhead Door']::text[], 85.00, 80.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('2ab669fa-fc63-5138-9f16-0635835ef696', 5, 'HVAC', ARRAY['HVAC']::text[], 95.00, 80.00, 142.50, 190.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('2ab669fa-fc63-5138-9f16-0635835ef696', 6, 'Appliances', ARRAY['Appliance']::text[], 95.00, 80.00, 142.50, 190.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('1bc48bcb-383b-53e0-8a86-328eb4dbddf3', 'AF', 'TCG', 65.00, 1.30, NULL, 2);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('1bc48bcb-383b-53e0-8a86-328eb4dbddf3', 0, 'Handyman', ARRAY['Handyman']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('1bc48bcb-383b-53e0-8a86-328eb4dbddf3', 1, 'Plumber', ARRAY['Plumbing']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('1bc48bcb-383b-53e0-8a86-328eb4dbddf3', 2, 'HVAC', ARRAY['HVAC']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('1bc48bcb-383b-53e0-8a86-328eb4dbddf3', 3, 'Appliances', ARRAY['Appliance']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('1bc48bcb-383b-53e0-8a86-328eb4dbddf3', 4, 'Electrician', ARRAY['Electric']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('1bc48bcb-383b-53e0-8a86-328eb4dbddf3', 5, 'Locksmith', ARRAY['Locksmith']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('1bc48bcb-383b-53e0-8a86-328eb4dbddf3', 6, 'OVH/Gates', ARRAY['Overhead Door']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('000414a9-a73e-5e5f-aca7-4ddca02902f0', 'AF', 'RMM', 65.00, 1.30, NULL, 3);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('000414a9-a73e-5e5f-aca7-4ddca02902f0', 0, 'Handyman', ARRAY['Handyman']::text[], 85.00, 75.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('000414a9-a73e-5e5f-aca7-4ddca02902f0', 1, 'Plumber', ARRAY['Plumbing']::text[], 85.00, 75.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('000414a9-a73e-5e5f-aca7-4ddca02902f0', 2, 'Locksmith', ARRAY['Locksmith']::text[], 95.00, 85.00, 142.50, 190.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('000414a9-a73e-5e5f-aca7-4ddca02902f0', 3, 'OVH/Gates', ARRAY['Overhead Door']::text[], 90.00, 80.00, 135.00, 180.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('000414a9-a73e-5e5f-aca7-4ddca02902f0', 4, 'HVAC - Appliances - Refrigeration', ARRAY['HVAC', 'Refrigeration', 'Appliance']::text[], 115.00, 105.00, 172.50, 230.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('000414a9-a73e-5e5f-aca7-4ddca02902f0', 5, 'Electrician', ARRAY['Electric']::text[], 85.00, 75.00, 127.50, 170.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('9f85d08d-ba7b-5e99-ad7f-6a8d95a94c8b', 'AF', 'JDE', 65.00, 1.30, 'After-hours rates start at 5pm.', 4);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('9f85d08d-ba7b-5e99-ad7f-6a8d95a94c8b', 0, 'Handyman - Locksmith - Doors - Glass', ARRAY['Handyman', 'Locksmith']::text[], 75.00, 60.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('9f85d08d-ba7b-5e99-ad7f-6a8d95a94c8b', 1, 'Plumber - Electrician', ARRAY['Plumbing', 'Electric']::text[], 75.00, 60.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('9f85d08d-ba7b-5e99-ad7f-6a8d95a94c8b', 2, 'Janitorial', ARRAY['Janitorial']::text[], 75.00, 60.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('9f85d08d-ba7b-5e99-ad7f-6a8d95a94c8b', 3, 'HVAC - Refrigeration', ARRAY['HVAC', 'Refrigeration']::text[], 90.00, 80.00, 142.50, 180.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('9f85d08d-ba7b-5e99-ad7f-6a8d95a94c8b', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('9f85d08d-ba7b-5e99-ad7f-6a8d95a94c8b', 1, 'Hydrojet', 400.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('3c4772ce-741e-50d2-8d7e-308525130156', 'AF', 'BrandPoint', 60.00, 1.30, NULL, 5);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('3c4772ce-741e-50d2-8d7e-308525130156', 0, 'Handyman', ARRAY['Handyman']::text[], 70.00, 65.00, 105.00, 140.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('3c4772ce-741e-50d2-8d7e-308525130156', 1, 'Plumber', ARRAY['Plumbing']::text[], 85.00, 75.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('3c4772ce-741e-50d2-8d7e-308525130156', 2, 'Locksmith', ARRAY['Locksmith']::text[], 75.00, 65.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('3c4772ce-741e-50d2-8d7e-308525130156', 3, 'OVH/Gates', ARRAY['Overhead Door']::text[], 85.00, 75.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('3c4772ce-741e-50d2-8d7e-308525130156', 4, 'HVAC - Appliances - Refrigeration', ARRAY['HVAC', 'Refrigeration', 'Appliance']::text[], 90.00, 80.00, 135.00, 180.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('3c4772ce-741e-50d2-8d7e-308525130156', 5, 'Electrician', ARRAY['Electric']::text[], 85.00, 75.00, 127.50, 170.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('f78ac8df-be6c-52ac-a371-f7c70fd7d4eb', 'AF', 'AFS', 65.00, 1.30, NULL, 6);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('f78ac8df-be6c-52ac-a371-f7c70fd7d4eb', 0, 'Handyman', ARRAY['Handyman']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('f78ac8df-be6c-52ac-a371-f7c70fd7d4eb', 1, 'Plumber', ARRAY['Plumbing']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('f78ac8df-be6c-52ac-a371-f7c70fd7d4eb', 2, 'Electrician', ARRAY['Electric']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('f78ac8df-be6c-52ac-a371-f7c70fd7d4eb', 3, 'Appliances', ARRAY['Appliance']::text[], 95.00, 80.00, 142.50, 190.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('f78ac8df-be6c-52ac-a371-f7c70fd7d4eb', 4, 'HVAC-R', ARRAY['HVAC', 'Refrigeration']::text[], 95.00, 80.00, 142.50, 190.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('f78ac8df-be6c-52ac-a371-f7c70fd7d4eb', 5, 'Locksmith', ARRAY['Locksmith']::text[], 95.00, 85.00, 142.50, 190.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('f78ac8df-be6c-52ac-a371-f7c70fd7d4eb', 6, 'OVH/Gates', ARRAY['Overhead Door']::text[], 90.00, 80.00, 135.00, 180.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('cb81cb91-e7a6-5624-973a-571d7153ce93', 'AF', 'NEST', 55.00, 1.30, NULL, 7);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('cb81cb91-e7a6-5624-973a-571d7153ce93', 0, 'Handyman', ARRAY['Handyman']::text[], 85.00, 80.00, 127.50, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('cb81cb91-e7a6-5624-973a-571d7153ce93', 1, 'Plumber', ARRAY['Plumbing']::text[], 85.00, 80.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('cb81cb91-e7a6-5624-973a-571d7153ce93', 2, 'HVAC-R', ARRAY['HVAC', 'Refrigeration']::text[], 95.00, 80.00, 142.50, 190.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('cb81cb91-e7a6-5624-973a-571d7153ce93', 3, 'Appliances', ARRAY['Appliance']::text[], 95.00, 80.00, 142.50, 190.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('cb81cb91-e7a6-5624-973a-571d7153ce93', 4, 'Electrician', ARRAY['Electric']::text[], 85.00, 80.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('cb81cb91-e7a6-5624-973a-571d7153ce93', 5, 'Locksmith', ARRAY['Locksmith']::text[], 95.00, 85.00, 142.50, 190.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('cb81cb91-e7a6-5624-973a-571d7153ce93', 6, 'OVH/Gates', ARRAY['Overhead Door']::text[], 90.00, 80.00, 135.00, 180.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('a2638787-68e1-54b1-b34e-d700853f01a0', 'AF', 'Front Street', 65.00, 1.30, NULL, 8);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('a2638787-68e1-54b1-b34e-d700853f01a0', 0, 'Handyman', ARRAY['Handyman']::text[], 75.00, 70.00, 112.50, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('a2638787-68e1-54b1-b34e-d700853f01a0', 1, 'Plumber', ARRAY['Plumbing']::text[], 75.00, 70.00, 112.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('a2638787-68e1-54b1-b34e-d700853f01a0', 2, 'Electrician', ARRAY['Electric']::text[], 75.00, 70.00, 112.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('a2638787-68e1-54b1-b34e-d700853f01a0', 3, 'Janitorial', ARRAY['Janitorial']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('a2638787-68e1-54b1-b34e-d700853f01a0', 4, 'HVAC-R', ARRAY['HVAC', 'Refrigeration']::text[], 85.00, 75.00, 127.50, 170.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('a2638787-68e1-54b1-b34e-d700853f01a0', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('a2638787-68e1-54b1-b34e-d700853f01a0', 1, 'Hydrojet', 450.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('ea0aaad4-16eb-548e-a81d-2a3d24d9d523', 'AF', 'Patriot', 65.00, 1.30, NULL, 9);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('ea0aaad4-16eb-548e-a81d-2a3d24d9d523', 0, 'Handyman', ARRAY['Handyman']::text[], 85.00, 75.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('ea0aaad4-16eb-548e-a81d-2a3d24d9d523', 1, 'Plumber', ARRAY['Plumbing']::text[], 85.00, 75.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('ea0aaad4-16eb-548e-a81d-2a3d24d9d523', 2, 'Electrician', ARRAY['Electric']::text[], 85.00, 75.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('ea0aaad4-16eb-548e-a81d-2a3d24d9d523', 3, 'HVAC - Refrigeration', ARRAY['HVAC', 'Refrigeration']::text[], 95.00, 85.00, 142.50, 190.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('ea0aaad4-16eb-548e-a81d-2a3d24d9d523', 4, 'Appliances', ARRAY['Appliance']::text[], 95.00, 85.00, 142.50, 190.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('d0087db2-07f9-505d-91bf-7d12d2682a8a', 'AF', 'DWM', 65.00, 1.30, NULL, 10);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('d0087db2-07f9-505d-91bf-7d12d2682a8a', 0, 'Handyman', ARRAY['Handyman']::text[], 80.00, 75.00, 120.00, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('d0087db2-07f9-505d-91bf-7d12d2682a8a', 1, 'Plumber', ARRAY['Plumbing']::text[], 80.00, 75.00, 120.00, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('d0087db2-07f9-505d-91bf-7d12d2682a8a', 2, 'Electrician', ARRAY['Electric']::text[], 80.00, 75.00, 120.00, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('d0087db2-07f9-505d-91bf-7d12d2682a8a', 3, 'Janitorial', ARRAY['Janitorial']::text[], 80.00, 75.00, 120.00, 160.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('d0087db2-07f9-505d-91bf-7d12d2682a8a', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('d0087db2-07f9-505d-91bf-7d12d2682a8a', 1, 'Hydrojet', 400.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('3c1a8cae-0a1b-5174-ac50-041dba7f8411', 'AF', 'Outback Staekhouse', 50.00, 1.30, NULL, 11);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('3c1a8cae-0a1b-5174-ac50-041dba7f8411', 0, 'Handyman', ARRAY['Handyman']::text[], 75.00, 70.00, 115.00, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('3c1a8cae-0a1b-5174-ac50-041dba7f8411', 1, 'Plumber', ARRAY['Plumbing']::text[], 85.00, 75.00, 130.00, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('3c1a8cae-0a1b-5174-ac50-041dba7f8411', 2, 'Electrician', ARRAY['Electric']::text[], 85.00, 75.00, 130.00, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('3c1a8cae-0a1b-5174-ac50-041dba7f8411', 3, 'Appliances', ARRAY['Appliance']::text[], 115.00, 100.00, 170.00, 230.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('3c1a8cae-0a1b-5174-ac50-041dba7f8411', 4, 'HVAC-R', ARRAY['HVAC', 'Refrigeration']::text[], 115.00, 100.00, 170.00, 230.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('3c1a8cae-0a1b-5174-ac50-041dba7f8411', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('3c1a8cae-0a1b-5174-ac50-041dba7f8411', 1, 'Hydrojet', 400.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('1a93fd6c-969b-5d04-b62d-e009ed5deb2e', 'AF', 'ResQ', 65.00, 1.30, NULL, 12);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('1a93fd6c-969b-5d04-b62d-e009ed5deb2e', 0, 'Handyman', ARRAY['Handyman']::text[], 80.00, 70.00, 120.00, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('1a93fd6c-969b-5d04-b62d-e009ed5deb2e', 1, 'Plumber', ARRAY['Plumbing']::text[], 80.00, 70.00, 120.00, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('1a93fd6c-969b-5d04-b62d-e009ed5deb2e', 2, 'Electrician', ARRAY['Electric']::text[], 80.00, 70.00, 120.00, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('1a93fd6c-969b-5d04-b62d-e009ed5deb2e', 3, 'Janitorial', ARRAY['Janitorial']::text[], 80.00, 70.00, 120.00, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('1a93fd6c-969b-5d04-b62d-e009ed5deb2e', 4, 'HVAC-R', ARRAY['HVAC', 'Refrigeration']::text[], 85.00, 75.00, 127.50, 170.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('1a93fd6c-969b-5d04-b62d-e009ed5deb2e', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('1a93fd6c-969b-5d04-b62d-e009ed5deb2e', 1, 'Hydrojet', 400.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('c354455a-64db-5405-9cd3-22c8e7b08b55', 'AF', 'Vixxo', 50.00, 1.30, NULL, 13);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('c354455a-64db-5405-9cd3-22c8e7b08b55', 0, 'Handyman', ARRAY['Handyman']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('c354455a-64db-5405-9cd3-22c8e7b08b55', 1, 'Plumber - Electrician', ARRAY['Plumbing', 'Electric']::text[], 85.00, 75.00, 127.50, 170.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('c354455a-64db-5405-9cd3-22c8e7b08b55', 2, 'HVAC - Appliances', ARRAY['HVAC', 'Appliance']::text[], 99.00, 80.00, 148.50, 198.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('c354455a-64db-5405-9cd3-22c8e7b08b55', 3, 'Janitorial', ARRAY['Janitorial']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('102d0b5f-b185-5dbe-99b1-0f01aa002143', 'AF', 'TFG', 65.00, 1.30, NULL, 14);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('102d0b5f-b185-5dbe-99b1-0f01aa002143', 0, 'Handyman', ARRAY['Handyman']::text[], 80.00, 75.00, 120.00, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('102d0b5f-b185-5dbe-99b1-0f01aa002143', 1, 'Plumber', ARRAY['Plumbing']::text[], 80.00, 75.00, 120.00, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('102d0b5f-b185-5dbe-99b1-0f01aa002143', 2, 'Electrician', ARRAY['Electric']::text[], 80.00, 75.00, 120.00, 160.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('102d0b5f-b185-5dbe-99b1-0f01aa002143', 3, 'Janitorial', ARRAY['Janitorial']::text[], 80.00, 75.00, 120.00, 160.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('102d0b5f-b185-5dbe-99b1-0f01aa002143', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('102d0b5f-b185-5dbe-99b1-0f01aa002143', 1, 'Hydrojet', 400.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('12f0da48-60c2-5553-9aed-cc5ddb00f464', 'AF', 'Addilan', 65.00, 1.30, NULL, 15);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('12f0da48-60c2-5553-9aed-cc5ddb00f464', 0, 'Handyman', ARRAY['Handyman']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('12f0da48-60c2-5553-9aed-cc5ddb00f464', 1, 'Plumber', ARRAY['Plumbing']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('12f0da48-60c2-5553-9aed-cc5ddb00f464', 2, 'HVAC-R', ARRAY['HVAC', 'Refrigeration']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('12f0da48-60c2-5553-9aed-cc5ddb00f464', 3, 'Appliances', ARRAY['Appliance']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('12f0da48-60c2-5553-9aed-cc5ddb00f464', 4, 'Electrician', ARRAY['Electric']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('12f0da48-60c2-5553-9aed-cc5ddb00f464', 5, 'Locksmith', ARRAY['Locksmith']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('12f0da48-60c2-5553-9aed-cc5ddb00f464', 6, 'OVH/Gates', ARRAY['Overhead Door']::text[], 75.00, 70.00, 112.50, 150.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('6f9ea616-0775-5767-8e0e-05c7ae3f1367', 'AF', 'All Systems', NULL, 1.30, NULL, 16);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('6f9ea616-0775-5767-8e0e-05c7ae3f1367', 0, 'Handyman', ARRAY['Handyman']::text[], 80.00, 70.00, 120.00, 160.00, 75.00);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('6f9ea616-0775-5767-8e0e-05c7ae3f1367', 1, 'Electrician', ARRAY['Electric']::text[], 90.00, 80.00, 135.00, 180.00, 80.00);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('6f9ea616-0775-5767-8e0e-05c7ae3f1367', 2, 'Plumber', ARRAY['Plumbing']::text[], 90.00, 80.00, 135.00, 180.00, 80.00);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('6f9ea616-0775-5767-8e0e-05c7ae3f1367', 3, 'HVAC-R', ARRAY['HVAC', 'Refrigeration']::text[], 110.00, 100.00, 165.00, 220.00, 90.00);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('6f9ea616-0775-5767-8e0e-05c7ae3f1367', 4, 'Locksmith', ARRAY['Locksmith']::text[], 90.00, 80.00, 135.00, 180.00, 75.00);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('6f9ea616-0775-5767-8e0e-05c7ae3f1367', 5, 'OVH Doors', ARRAY['Overhead Door']::text[], 100.00, 90.00, 150.00, 200.00, 95.00);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('6f9ea616-0775-5767-8e0e-05c7ae3f1367', 0, 'Snake', 0.00, 'No fee');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('6f9ea616-0775-5767-8e0e-05c7ae3f1367', 1, 'Hydrojet', 0.00, 'No fee');
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('1d5cde95-cad8-540f-bed7-2bbda0466152', 'RF', NULL, NULL, NULL, NULL, 0);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('1d5cde95-cad8-540f-bed7-2bbda0466152', 0, 'Snake', 250.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('1d5cde95-cad8-540f-bed7-2bbda0466152', 1, 'Bucket truck', 300.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('1d5cde95-cad8-540f-bed7-2bbda0466152', 2, 'Jetter', NULL, '$350-550');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('1d5cde95-cad8-540f-bed7-2bbda0466152', 3, 'Generator', NULL, '$300-12,000 per day');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('1d5cde95-cad8-540f-bed7-2bbda0466152', 4, 'Jackhammer', 175.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('1d5cde95-cad8-540f-bed7-2bbda0466152', 5, 'Backflow', NULL, '$250 per device');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('1d5cde95-cad8-540f-bed7-2bbda0466152', 6, 'Welding', NULL, '$50-300');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('1d5cde95-cad8-540f-bed7-2bbda0466152', 7, 'Septic Truck', 1200.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('1d5cde95-cad8-540f-bed7-2bbda0466152', 8, 'Boomlift', NULL, '$650-1500 per day');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('1d5cde95-cad8-540f-bed7-2bbda0466152', 9, 'Leak test', 150.00, NULL);
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('1d5cde95-cad8-540f-bed7-2bbda0466152', 10, 'Scissor lift', NULL, '$650(19ft), $800(26ft), $1,000(32ft), $1,500 (50ft)');
INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ('1d5cde95-cad8-540f-bed7-2bbda0466152', 11, 'Vacuum', 150.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('0579e757-133e-579e-a387-136bb551a3e0', 'RF', 'JDE', 65.00, 1.30, NULL, 1);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('0579e757-133e-579e-a387-136bb551a3e0', 0, 'Handyman - Locksmith - Doors - Glass', ARRAY['Handyman', 'Locksmith']::text[], 80.00, 70.00, 120.00, 120.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('0579e757-133e-579e-a387-136bb551a3e0', 1, 'Plumber - Electrician', ARRAY['Plumbing', 'Electric']::text[], 90.00, 80.00, 135.00, 202.50, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('0579e757-133e-579e-a387-136bb551a3e0', 2, 'OVH/Gates', ARRAY['Overhead Door']::text[], 80.00, 70.00, 120.00, 120.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('0579e757-133e-579e-a387-136bb551a3e0', 3, 'HVAC - Appliances - Refrigeration', ARRAY['HVAC', 'Refrigeration', 'Appliance']::text[], 90.00, 70.00, 120.00, 120.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('07ec6d96-d4b3-5c59-a5f0-13ff3df09094', 'RF', 'Lessen', 65.00, 1.30, NULL, 2);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('07ec6d96-d4b3-5c59-a5f0-13ff3df09094', 0, 'Handyman - Locksmith - Doors - Glass', ARRAY['Handyman', 'Locksmith']::text[], 80.00, 70.00, 120.00, 120.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('07ec6d96-d4b3-5c59-a5f0-13ff3df09094', 1, 'Plumber', ARRAY['Plumbing']::text[], 80.00, 70.00, 120.00, 120.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('07ec6d96-d4b3-5c59-a5f0-13ff3df09094', 2, 'Electrician', ARRAY['Electric']::text[], 80.00, 70.00, 120.00, 120.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('07ec6d96-d4b3-5c59-a5f0-13ff3df09094', 3, 'HVAC - Refrigeration', ARRAY['HVAC', 'Refrigeration']::text[], 95.00, 85.00, 142.50, 142.50, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('25d48868-7391-5c59-86fa-546079006dbb', 'RF', 'PH', 65.00, 1.30, NULL, 3);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('25d48868-7391-5c59-86fa-546079006dbb', 0, 'Handyman - Locksmith - Doors - Glass', ARRAY['Handyman', 'Locksmith']::text[], 80.00, 70.00, 120.00, 120.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('25d48868-7391-5c59-86fa-546079006dbb', 1, 'Plumber - Electrician', ARRAY['Plumbing', 'Electric']::text[], 80.00, 70.00, 120.00, 120.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('25d48868-7391-5c59-86fa-546079006dbb', 2, 'HVAC - Refrigeration', ARRAY['HVAC', 'Refrigeration']::text[], 90.00, 80.00, 135.00, 135.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('30689f5f-54bb-5064-b5c9-0d3684234137', 'RF', 'Front Street', 65.00, 1.30, NULL, 4);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('30689f5f-54bb-5064-b5c9-0d3684234137', 0, 'Handyman - Locksmith - Doors - Glass', ARRAY['Handyman', 'Locksmith']::text[], 80.00, 70.00, 120.00, 120.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('30689f5f-54bb-5064-b5c9-0d3684234137', 1, 'Plumber - Electrician', ARRAY['Plumbing', 'Electric']::text[], 80.00, 70.00, 120.00, 120.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('30689f5f-54bb-5064-b5c9-0d3684234137', 2, 'OVH/Gates', ARRAY['Overhead Door']::text[], 80.00, 70.00, 120.00, 120.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('30689f5f-54bb-5064-b5c9-0d3684234137', 3, 'HVAC - Appliances - Refrigeration', ARRAY['HVAC', 'Refrigeration', 'Appliance']::text[], 90.00, 80.00, 135.00, 135.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('3d47d475-38d3-51ec-a4a6-e3273a4ff238', 'RF', 'Truesource', 75.00, 1.30, NULL, 5);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('3d47d475-38d3-51ec-a4a6-e3273a4ff238', 0, 'Handyman - Locksmith - Doors - Glass', ARRAY['Handyman', 'Locksmith']::text[], 85.00, 75.00, 127.50, 127.50, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('3d47d475-38d3-51ec-a4a6-e3273a4ff238', 1, 'Plumber - Electrician', ARRAY['Plumbing', 'Electric']::text[], 85.00, 75.00, 127.50, 127.50, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('3d47d475-38d3-51ec-a4a6-e3273a4ff238', 2, 'OVH/Gates', ARRAY['Overhead Door']::text[], 90.00, 80.00, 135.00, 135.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('3d47d475-38d3-51ec-a4a6-e3273a4ff238', 3, 'HVAC - Appliances - Refrigeration', ARRAY['HVAC', 'Refrigeration', 'Appliance']::text[], 90.00, 80.00, 135.00, 135.00, NULL);
INSERT INTO price_card (id, billing_entity, client, trip_rate, materials_markup, note, position) VALUES ('b15feeac-561d-5fc5-b3e9-1e1d9de6f4d9', 'RF', 'KBS', 60.00, 1.30, NULL, 6);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('b15feeac-561d-5fc5-b3e9-1e1d9de6f4d9', 0, 'Handyman - Locksmith - Doors - Glass', ARRAY['Handyman', 'Locksmith']::text[], 80.00, 70.00, 120.00, 120.00, NULL);
INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate) VALUES ('b15feeac-561d-5fc5-b3e9-1e1d9de6f4d9', 1, 'Plumber - Electrician', ARRAY['Plumbing', 'Electric']::text[], 90.00, 70.00, 120.00, 120.00, NULL);
