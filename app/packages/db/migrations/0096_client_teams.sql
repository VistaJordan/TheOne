-- 0096 · The account team per client and billing entity (Elise, 2026-10-27).
-- Vocabulary: packages/shared/src/clientTeams.ts. The API: services/
-- clientTeams.ts; edited on Clients › a client › Account team.
--
-- Who looks after a client depends on which of our companies bills it (PH
-- has a team under BKR, another under AF, TPM and RF), so a team is one row
-- per (client, Comp): Team Lead, Assistant Team Lead, salesperson, Account
-- Manager. Names are kept as the team sheet gives them (first names; "House"
-- = no salesperson); the create form resolves each to an account's display
-- name when exactly one active person answers to it.
--
-- "Add work order" fills AM, TL and ATL from the team once the Client and the
-- Comp are picked; the dispatcher (Assignee) is always picked by hand.
--
-- 1. client_team. No FK to principal (updated_by is a plain uuid): the seed
--    TRUNCATEs principal … CASCADE and the teams are configuration that must
--    survive a re-seed, like `client` itself (which the seed never truncates).
-- 2. The ATL field (and TL, which the seed has always carried but no
--    migration declared), both offered on the create form. seed.ts carries the
--    same rows and WO_CREATE_DEFAULT_KEYS lists both — KEEP IN STEP.
-- 3. A client record for every client on the sheet not already on file
--    (matched like everywhere else, lower(btrim(name))), then the sheet's
--    teams. TPM / PRS is on the sheet twice with different leads: the first
--    row (Gloria / Sammy) is kept, the second is a comment below.

CREATE TABLE client_team (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  billing_entity text NOT NULL CHECK (btrim(billing_entity) <> ''),
  tl             text,
  atl            text,
  sales          text,
  am             text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid
);

CREATE UNIQUE INDEX client_team_one_per_entity ON client_team (client_id, upper(btrim(billing_entity)));

INSERT INTO field_def (container_id, key, label, type, type_config, position)
SELECT c.id, v.key, v.label, v.type::field_type, '{}'::jsonb,
       (SELECT COALESCE(max(position), 0) FROM field_def WHERE container_id = c.id) + v.ord
  FROM container c
  CROSS JOIN (VALUES
    ('TL',  'Team Lead',           'users', 1),
    ('ATL', 'Assistant Team Lead', 'users', 2)
  ) AS v(key, label, type, ord)
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;

UPDATE field_def SET create_mode = 'optional' WHERE key IN ('TL', 'ATL') AND create_mode = 'off';

CREATE TEMP TABLE ct_sheet (comp text, client text, tl text, atl text, sales text, am text) ON COMMIT DROP;
INSERT INTO ct_sheet VALUES
  ('SFM', '7-11', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'Flynn Group', 'Josh', 'Fady', 'Teresa', 'Peter'),
  ('SFM', 'PCRK', 'Josh', 'Fady', 'Teresa', 'Peter'),
  ('SFM', 'MOD Pizza', 'Josh', 'Fady', 'Teresa', 'Peter'),
  ('SFM', 'WKS', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'Riser Fitness', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'Green Thumb', 'Josh', 'Fady', 'Teresa', 'Peter'),
  ('SFM', 'Qdoba', 'Josh', 'Fady', 'Teresa', 'Peter'),
  ('SFM', 'Puttshack', 'Josh', 'Fady', 'Teresa', 'Peter'),
  ('SFM', '5Guys', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'DoorDash', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'OXXO', 'Josh', 'Fady', 'Teresa', 'Peter'),
  ('SFM', 'Macy''s', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'Planned Parenthood', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'Vuori', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'Learning Experience', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'Cheesecake Factory', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'Mobettah''s', 'Josh', 'Fady', 'Teresa', 'Peter'),
  ('SFM', 'Portland Leather', 'Josh', 'Fady', 'Teresa', 'Peter'),
  ('SFM', 'First Watch', 'Josh', 'Fady', 'Teresa', 'Peter'),
  ('SFM', 'Mimi''s Cafe', 'Josh', 'Fady', 'Teresa', 'Peter'),
  ('SFM', 'Rural King', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'Uncommon Brands', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'Wendy''s Corp', 'Josh', 'Fady', 'Teresa', 'Peter'),
  ('SFM', 'Din Tai Fung', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'Habit Burger', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'KinderCare', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'Canteen', 'Josh', 'Fady', 'House', 'Peter'),
  ('SFM', 'Swig Stores', 'Josh', 'Fady', 'Teresa', 'Peter'),
  ('SFM', 'Basha''s', 'Josh', 'Fady', 'House', 'Peter'),
  ('SFM', 'JRSK', 'Josh', 'Fady', 'House', 'Peter'),
  ('SFM', 'Extra Space Storage', 'Josh', 'Fady', 'Rocio', 'Peter'),
  ('SFM', 'ONO BBQ', 'Josh', 'Fady', 'House', 'Peter'),
  ('SFM', 'Fedex', 'Josh', 'Fady', 'House', 'Peter'),
  ('SFM', 'Sun Holdings', 'Charles', 'Lucas', 'Rocio', 'Peter'),
  ('SFM', 'RMH', 'Charles', 'Lucas', 'Rocio', 'Peter'),
  ('SFM', 'AMP', 'Charles', 'Lucas', 'Rocio', 'Peter'),
  ('SFM', 'Biscuit Ville', 'Charles', 'Lucas', 'Teresa', 'Peter'),
  ('SFM', 'Net Lease', 'Charles', 'Lucas', 'Rocio', 'Peter'),
  ('SFM', 'Car Mart', 'Charles', 'Lucas', 'House', 'Peter'),
  ('SFM', 'IRC', 'Charles', 'Lucas', 'Teresa', 'Peter'),
  ('SFM', 'Sizzling Platter', 'Gloria', 'Sammy', 'Teresa', 'Peter'),
  ('SFM', 'AMC', 'Gloria', 'Sammy', 'Teresa', 'Peter'),
  ('BKR', 'EMCOR', 'Gloria', 'Sammy', 'Kevin', 'Kevin'),
  ('BKR', 'Branded', 'Mary', 'Mary', 'House', 'Peter'),
  ('BKR', 'PH', 'Mary', 'Mary', 'House', 'Peter'),
  ('AF', 'FreshCo', 'Mary', 'Mary', 'House', 'Peter'),
  ('AF', 'O''reilly', 'Mary', 'Mary', 'House', 'Peter'),
  ('AF', 'AFS', 'Mary', 'Mary', 'House', 'Peter'),
  ('AF', 'FSFS', 'Mary', 'Mary', 'House', 'Peter'),
  ('AF', 'ResQ', 'Mary', 'Mary', 'House', 'Peter'),
  ('AF', 'Impact', 'Mary', 'Mary', 'House', 'Peter'),
  ('AF', 'NEST', 'Mary', 'Mary', 'House', 'Peter'),
  ('AF', 'Ferrandino&Son', 'Mary', 'Mary', 'House', 'Peter'),
  ('AF', 'RMM', 'Mary', 'Mary', 'House', 'Peter'),
  ('AF', 'Patriot', 'Mary', 'Mary', 'House', 'Peter'),
  ('AF', 'PH', 'Mary', 'Mary', 'House', 'Peter'),
  ('AF', 'Outback Staekhouse', 'Mary', 'Mary', 'House', 'Peter'),
  ('AF', 'All Systems', 'Mary', 'Mary', 'House', 'Peter'),
  ('TPM', 'Laser', 'Gloria', 'Sammy', 'House', 'Peter'),
  ('TPM', 'PRS', 'Gloria', 'Sammy', 'House', 'Peter'),
  ('TPM', 'Vixxo', 'Mary', 'Mary', 'House', 'Peter'),
  ('TPM', 'Truesource', 'Mary', 'Mary', 'House', 'Peter'),
  -- duplicate on the sheet, the first row wins: ('TPM', 'PRS', 'Mary', 'Mary', 'House', 'Peter')
  ('TPM', 'RSM LEO', 'Mary', 'Mary', 'House', 'Peter'),
  ('TPM', 'HERO', 'Mary', 'Mary', 'House', 'Peter'),
  ('TPM', 'ResQ', 'Mary', 'Mary', 'House', 'Peter'),
  ('TPM', 'NEST', 'Mary', 'Mary', 'House', 'Peter'),
  ('TPM', 'AFS', 'Mary', 'Mary', 'House', 'Peter'),
  ('TPM', '23rd Group', 'Mary', 'Mary', 'House', 'Peter'),
  ('TPM', 'SFS', 'Mary', 'Mary', 'House', 'Peter'),
  ('TPM', 'AAFM', 'Mary', 'Mary', 'House', 'Peter'),
  ('TPM', 'DAVACO', 'Mary', 'Mary', 'House', 'Peter'),
  ('TPM', 'KFM', 'Mary', 'Mary', 'House', 'Peter'),
  ('TPM', 'PH', 'Mary', 'Mary', 'House', 'Peter'),
  ('RF', 'Lessen', 'Mary', 'Mary', 'House', 'Peter'),
  ('RF', 'PH', 'Mary', 'Mary', 'House', 'Peter'),
  ('RF', 'FSFS', 'Mary', 'Mary', 'House', 'Peter');

INSERT INTO client (name)
SELECT DISTINCT ON (lower(btrim(s.client))) btrim(s.client)
  FROM ct_sheet s
 WHERE NOT EXISTS (SELECT 1 FROM client c WHERE c.deleted_at IS NULL AND lower(btrim(c.name)) = lower(btrim(s.client)))
 ORDER BY lower(btrim(s.client))
ON CONFLICT DO NOTHING;

INSERT INTO client_team (client_id, billing_entity, tl, atl, sales, am)
SELECT c.id, upper(btrim(s.comp)), NULLIF(btrim(s.tl), ''), NULLIF(btrim(s.atl), ''), NULLIF(btrim(s.sales), ''), NULLIF(btrim(s.am), '')
  FROM ct_sheet s
  JOIN LATERAL (
    SELECT id FROM client c
     WHERE c.deleted_at IS NULL AND lower(btrim(c.name)) = lower(btrim(s.client))
     ORDER BY c.created_at LIMIT 1
  ) c ON true
ON CONFLICT DO NOTHING;
