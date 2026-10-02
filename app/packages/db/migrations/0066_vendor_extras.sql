-- 0066 · Vendors, the rest (Facilio parity): invoicing rules and credit
-- notes, the dispatch cascade, skills / inductions / consumables, and the
-- vendor portal (onboarding, and the jobs of a vendor already on file).
--
-- Everything is additive. Three things are OFF or WARN-ONLY by design:
--   · the dispatch cascade ships switched off (vendor_setting
--     `dispatch_cascade`.enabled = false). Until somebody turns it on,
--     assigning a vendor is exactly what it was.
--   · the invoicing rules never block a vendor bill: they are warnings drawn
--     on the bill. Approving and paying behave exactly as before.
--   · a credit note changes no stored total. A bill's "net" is its total
--     minus its approved credit notes, computed on the read.
-- No email is sent anywhere here: a portal link is copied and handed over by
-- a person.

-- ── Invoicing rules (configuration, in the vendor_setting table of 0057) ────

INSERT INTO vendor_setting (key, value) VALUES
  ('bill_rules', '{
     "bill_number_required": true,
     "duplicate_number": true,
     "over_cost": true,
     "vendor_not_on_wo": true,
     "before_completion": true,
     "late_days": 30,
     "credit_approval_over": 250
   }'::jsonb),
  ('dispatch_cascade', '{"enabled": false, "auto_start": false, "hours": 4}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── Credit notes against a vendor bill ──────────────────────────────────────

CREATE SEQUENCE vendor_credit_note_seq START 1001;

CREATE TABLE vendor_credit_note (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_number text NOT NULL UNIQUE DEFAULT ('CN-' || nextval('vendor_credit_note_seq')),
  bill_id       uuid NOT NULL REFERENCES vendor_bill(id) ON DELETE CASCADE,
  task_id       uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  reason        text NOT NULL,
  -- The vendor's own credit memo number, when they sent one.
  vendor_ref    text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'void')),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid,
  decided_at    timestamptz,
  void_reason   text
);
CREATE INDEX vendor_credit_note_bill_idx ON vendor_credit_note (bill_id);
CREATE INDEX vendor_credit_note_task_idx ON vendor_credit_note (task_id);

-- ── Dispatch cascade: offering a job to the preferred vendors in turn ───────

CREATE TABLE wo_dispatch_offer (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  vendor_id     uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  rank          int NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'accepted', 'declined', 'expired', 'cancelled')),
  offered_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  responded_at  timestamptz,
  -- 'portal' = the vendor answered on their link; 'staff' = one of us
  -- recorded the answer; 'system' = the clock ran out or the run was stopped.
  responded_via text,
  note          text,
  started_by    uuid
);
CREATE INDEX wo_dispatch_offer_task_idx ON wo_dispatch_offer (task_id, offered_at);
CREATE INDEX wo_dispatch_offer_vendor_idx ON wo_dispatch_offer (vendor_id) WHERE status = 'offered';
-- One live offer per work order.
CREATE UNIQUE INDEX wo_dispatch_offer_live ON wo_dispatch_offer (task_id) WHERE status = 'offered';

-- ── Skills, inductions, consumables ─────────────────────────────────────────

-- The skill list is configuration (no FK to anything a re-seed truncates).
CREATE TABLE skill (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL,
  trade     text,
  is_active boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX skill_name_key ON skill (lower(name));

INSERT INTO skill (name, trade) VALUES
  ('EPA 608 Universal', 'HVAC'),
  ('Walk-in cooler / freezer', 'Refrigeration'),
  ('Ice machines', 'Refrigeration'),
  ('Rooftop units', 'HVAC'),
  ('Backflow testing', 'Plumbing'),
  ('Hydro-jetting', 'Plumbing'),
  ('Licensed electrician', 'Electric'),
  ('Lift certified', NULL),
  ('OSHA 10', NULL),
  ('OSHA 30', NULL);

CREATE TABLE vendor_skill (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  skill           text NOT NULL,
  level           text NOT NULL DEFAULT 'skilled' CHECK (level IN ('basic', 'skilled', 'expert')),
  certified_until date,
  note            text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vendor_skill_key ON vendor_skill (vendor_id, lower(skill));

-- An induction is a briefing a vendor must have had before working for a
-- client or at a site: when it was done and when it runs out.
CREATE TABLE vendor_induction (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id    uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  title        text NOT NULL,
  client       text,
  completed_on date,
  expires_on   date,
  note         text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_induction_vendor_idx ON vendor_induction (vendor_id);

-- Consumables: the small stock a job uses up (refrigerant, filters, belts).
CREATE TABLE consumable (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL,
  unit      text NOT NULL DEFAULT 'each',
  unit_cost numeric(12,2),
  is_active boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX consumable_name_key ON consumable (lower(name));

INSERT INTO consumable (name, unit, unit_cost) VALUES
  ('R-404A refrigerant', 'lb', 14.00),
  ('R-410A refrigerant', 'lb', 12.00),
  ('R-448A refrigerant', 'lb', 22.00),
  ('Air filter 20x20x2', 'each', 9.50),
  ('Condenser fan motor', 'each', 145.00),
  ('Contactor', 'each', 28.00),
  ('Capacitor', 'each', 18.00),
  ('V-belt', 'each', 16.00);

CREATE TABLE wo_consumable (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  vendor_id     uuid REFERENCES vendor(id) ON DELETE SET NULL,
  consumable_id uuid,
  name          text NOT NULL,
  unit          text NOT NULL DEFAULT 'each',
  qty           numeric(10,2) NOT NULL DEFAULT 1,
  unit_cost     numeric(12,2),
  note          text,
  added_by      uuid,
  added_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wo_consumable_task_idx ON wo_consumable (task_id, added_at);
CREATE INDEX wo_consumable_vendor_idx ON wo_consumable (vendor_id) WHERE vendor_id IS NOT NULL;

-- ── The vendor portal ───────────────────────────────────────────────────────
-- A link is the credential: 32 url-safe characters, of which only the SHA-256
-- is stored, so a copy of this table opens nothing. A link belongs to ONE
-- vendor record and shows only that vendor's jobs. It can be revoked and it
-- can expire. `purpose`:
--   onboarding   the vendor fills in their own profile; what they send waits
--                in vendor_onboarding until one of us accepts it
--   portal       the vendor sees the jobs they hold, answers offers, gives
--                an ETA and leaves notes

CREATE TABLE vendor_portal_link (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id    uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  purpose      text NOT NULL CHECK (purpose IN ('onboarding', 'portal')),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  use_count    int NOT NULL DEFAULT 0,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_portal_link_vendor_idx ON vendor_portal_link (vendor_id);

CREATE TABLE vendor_onboarding (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id    uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  link_id      uuid,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'accepted', 'rejected')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_by   uuid,
  decided_at   timestamptz,
  decision_note text
);
CREATE INDEX vendor_onboarding_vendor_idx ON vendor_onboarding (vendor_id, submitted_at DESC);

-- What a vendor wrote on their portal about a job. Kept in its own table (and
-- copied onto the work order as an internal note by the service), so nothing
-- a vendor types is ever mistaken for something one of us wrote.
CREATE TABLE vendor_portal_note (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  vendor_id  uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_portal_note_task_idx ON vendor_portal_note (task_id, created_at);

-- ── Who may do what ─────────────────────────────────────────────────────────
-- `vendors/portal` (edit = make and revoke links, accept an onboarding) and
-- `vendors/dispatch` (edit = start and stop a cascade, record an answer).
-- Only fills a path the role has not set.

UPDATE role SET permissions = permissions
    || jsonb_build_object('vendors/portal', jsonb_build_object('view', true, 'edit', true),
                          'vendors/dispatch', jsonb_build_object('view', true, 'edit', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am', 'vr_officer') AND NOT (permissions ? 'vendors/portal');

UPDATE role SET permissions = permissions
    || jsonb_build_object('vendors/portal', jsonb_build_object('view', false, 'edit', false),
                          'vendors/dispatch', jsonb_build_object('view', true, 'edit', true))
 WHERE code IN ('om', 'om_probation', 'senior_om', 'ops_coord') AND NOT (permissions ? 'vendors/portal');

UPDATE role SET permissions = permissions
    || jsonb_build_object('vendors/portal', jsonb_build_object('view', false, 'edit', false),
                          'vendors/dispatch', jsonb_build_object('view', false, 'edit', false))
 WHERE NOT (permissions ? 'vendors/portal');
