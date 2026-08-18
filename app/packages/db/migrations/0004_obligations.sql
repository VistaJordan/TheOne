-- ============================================================================
-- 0004_obligations.sql — Sprint 5: the obligation engine (smart notifications).
--
-- AN OBLIGATION IS: who owes what, on which work order, by when — and what
-- EVIDENCE silences it. Notifications are VIEWS of obligations, never a second
-- source of truth; that is why `notification` has no state of its own beyond
-- `read_at`, and why there is no "dismiss obligation" column anywhere below.
-- Resolution is evidence-only: the evaluator closes an obligation when the
-- world stops owing it, and a human can only SNOOZE (with a mandatory reason).
--
-- FOUR TABLES, in dependency order:
--
--   obligation_rule ── CONFIG. The seven V1 rules live as DATA, with their
--                      thresholds in `params` JSONB, so "make it 3 business
--                      days" is an UPDATE and not a deploy.
--   obligation ─────── one live clock. Stable identity is (rule_key, subject_id)
--                      so re-evaluation UPDATES rather than duplicates.
--   obligation_ping ── the no-respam ledger: one row per (obligation, tier)
--                      EVER. This is the escalation bot's "each obligation pings
--                      once" rule, made a database constraint instead of a hope.
--   notification ───── the fan-out. One row per recipient per ping.
--
-- Postgres-16 compatible; the runner passes this file WHOLE to db.exec().
-- ============================================================================

-- ── OBLIGATION RULE — thresholds as data ────────────────────────────────────
-- `params` shape (every key optional, read by services/obligations.ts):
--   clock                 'business' | '24x7'
--   business_hours        budget, in business hours   (10h = one business day)
--   business_days         budget, in business days
--   hours                 budget, in wall hours       (24/7 clocks only)
--   statuses              status names that OPEN the clock
--   priorities            task priorities that qualify
--   quote_status          quote lifecycle state that opens the clock
--   payment_status        payment_request state that opens the clock
--   status_groups         status groups the subject must still be in
--   field                 task.fields key holding the date (sla_blown)
--   grace_business_hours  nominal budget for a date-based rule (sla_blown)
--   owed_by_role          fallback owner when no principal resolves
--   critical_on_breach    true → any breach jumps straight to tier 3
--   chip_label            short label the table's Clock column prints
CREATE TABLE obligation_rule (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key    text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER obligation_rule_touch BEFORE UPDATE ON obligation_rule
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── OBLIGATION — one live clock ─────────────────────────────────────────────
-- `rule_key` is deliberately NOT a foreign key. Rules are config that an
-- operator may retire mid-flight, and a live obligation must survive its rule
-- row being deactivated or renamed — the evaluator carries the vocabulary, the
-- table carries the history. (Consistency is asserted by the evaluator, which
-- only ever writes keys it has loaded from obligation_rule.)
--
-- `subject_id` is the thing the clock is ABOUT: the task for wo-rules, the quote
-- id for quote_review_owed, the payment_request id for payment_processing.
-- `task_id` is ALWAYS filled anyway, so every obligation can name a work order.
--
-- `owed_by_principal` XOR `owed_by_role`: a person when the work order's home
-- list resolves to one, otherwise the role that collectively owes it (rule 5 →
-- atl, rule 6 → admin). App-enforced, not CHECKed: an obligation with neither
-- is legal and simply fans out to leadership.
CREATE TABLE obligation (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key            text NOT NULL,
  task_id             uuid REFERENCES task(id) ON DELETE CASCADE,
  subject_kind        text NOT NULL CHECK (subject_kind IN ('wo','quote','payment')),
  subject_id          uuid NOT NULL,
  owed_by_principal   uuid REFERENCES principal(id),
  owed_by_role        text,
  opened_at           timestamptz NOT NULL DEFAULT now(),
  due_at              timestamptz NOT NULL,
  clock               text NOT NULL DEFAULT 'business' CHECK (clock IN ('business','24x7')),
  tier                int  NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','snoozed','resolved')),
  resolved_by_evidence text,
  resolved_at         timestamptz,
  snooze_reason       text,
  snoozed_by          uuid REFERENCES principal(id),
  snoozed_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- STABLE IDENTITY. One LIVE obligation per (rule, subject); resolved rows are
-- history and may pile up (the same emergency can be missed twice).
-- A partial unique INDEX (not a table constraint) is the only formulation
-- Postgres allows for a predicated uniqueness rule — and it is what PGlite
-- supports, since `status <> 'resolved'` is immutable.
CREATE UNIQUE INDEX obligation_live_identity_idx
  ON obligation (rule_key, subject_id)
  WHERE status <> 'resolved';

CREATE INDEX obligation_task_idx   ON obligation (task_id, status);
CREATE INDEX obligation_live_idx   ON obligation (status, tier DESC, due_at ASC);
CREATE INDEX obligation_owner_idx  ON obligation (owed_by_principal, status);
CREATE INDEX obligation_role_idx   ON obligation (owed_by_role, status);
CREATE TRIGGER obligation_touch BEFORE UPDATE ON obligation
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── OBLIGATION PING — the no-respam ledger ──────────────────────────────────
-- The escalation bot's hardest-won rule: an obligation pings each tier ONCE,
-- ever. Not "once per hour", not "once per digest" — once. The UNIQUE below is
-- what enforces it, so a re-evaluation storm cannot produce a notification
-- storm even if the tier maths is wrong.
CREATE TABLE obligation_ping (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id uuid NOT NULL REFERENCES obligation(id) ON DELETE CASCADE,
  tier          int  NOT NULL,
  pinged_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (obligation_id, tier)
);
CREATE INDEX obligation_ping_obligation_idx ON obligation_ping (obligation_id);

-- ── NOTIFICATION — the fan-out ──────────────────────────────────────────────
-- One row per recipient per ping. `wo_number` is DENORMALISED on purpose: the
-- bell must be able to say which work order without a join, and every
-- escalation the bot ever sent carried a WO number (or said it could not find
-- one) — that discipline is worth a text column.
CREATE TABLE notification (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id  uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  obligation_id uuid NOT NULL REFERENCES obligation(id) ON DELETE CASCADE,
  tier          int  NOT NULL,
  title         text NOT NULL,
  body          text,
  wo_number     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz
);
CREATE INDEX notification_inbox_idx  ON notification (principal_id, created_at DESC);
CREATE INDEX notification_unread_idx ON notification (principal_id) WHERE read_at IS NULL;
CREATE INDEX notification_obligation_idx ON notification (obligation_id);

-- ── THE SEVEN V1 RULES ──────────────────────────────────────────────────────
-- Seeded HERE rather than in seed.ts because they are schema-adjacent config,
-- not demo data: a pgdata that is migrated but never re-seeded still has a
-- working engine. ON CONFLICT keeps the migration re-runnable by hand.
INSERT INTO obligation_rule (rule_key, name, description, params) VALUES
  ('emergency_ack',
   'Emergency not acknowledged',
   'An emergency work order with nobody on it. Two hours, around the clock — emergencies do not keep business hours.',
   '{"clock":"24x7","hours":2,"statuses":["Open","emergency"],"priorities":["high"],"critical_on_breach":true,"chip_label":"Ack emergency"}'::jsonb),

  ('quote_owed',
   'Quote owed to the client',
   'The work order has been sitting in "waiting for quote" for two business days and no quote exists.',
   '{"clock":"business","business_days":2,"statuses":["waiting for quote"],"chip_label":"Quote owed"}'::jsonb),

  ('schedule_owed',
   'ETA owed after approval',
   'The client approved and nobody has scheduled it. Two business hours to put a date on it.',
   '{"clock":"business","business_hours":2,"statuses":["approved","!! approved"],"chip_label":"ETA owed"}'::jsonb),

  ('approval_followup',
   'Client approval needs chasing',
   'Five business days waiting on the client with no client-visible update from us. Chase it.',
   '{"clock":"business","business_days":5,"statuses":["!! waiting for approval"],"chip_label":"Chase client"}'::jsonb),

  ('quote_review_owed',
   'Quote waiting on review',
   'A quote has been sitting in pending_approval for four business hours. Owed by whoever can approve.',
   '{"clock":"business","business_hours":4,"quote_status":"pending_approval","owed_by_role":"atl","chip_label":"Quote review"}'::jsonb),

  ('payment_processing',
   'Payment request unprocessed',
   'A technician payment request has been in "requested" for two business days. Owed by AP.',
   '{"clock":"business","business_days":2,"payment_status":"requested","owed_by_role":"admin","chip_label":"Payment owed"}'::jsonb),

  ('sla_blown',
   'SLA date blown',
   'The work order''s SLA due date has passed and it is still open or active. Fires once.',
   '{"clock":"business","grace_business_hours":10,"field":"SLA Due Date","status_groups":["open","active"],"critical_on_breach":false,"chip_label":"SLA blown"}'::jsonb)
ON CONFLICT (rule_key) DO NOTHING;
