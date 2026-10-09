-- ============================================================================
-- 0028_quotes_payments_v2.sql — Yoda parity for quotes and technician payments.
--
-- Source of truth for the business rules is the Yoda WebApi (QuoteOption
-- approval SQL, ActionEngine, PaymentEngine, PaymentRepository W9 window). This
-- migration brings the S4 skeleton up to those rules WITHOUT breaking the S4
-- payloads: every existing column keeps its meaning, new columns default to the
-- behaviour the S4 code already assumed.
--
-- Sits on top of 0016 (payment approval + Yoda hand-off): the decision stamps
-- 0016 added (approved_by/at, rejected_by/at, rejection_note, paid_by/at,
-- updated_at, payment_request_status_idx) are REUSED, not duplicated. The
-- 'sent_to_yoda' status and its stamps are RETIRED — this branch is the Yoda
-- payment flow itself, so there is nothing to hand off to — but the value stays
-- legal in the CHECK so rows that reached it keep their history.
--
-- Decisions applied (product/quotes-payments-gap-analysis.md §5):
--   D1  grand total = (incurred + option) × (1 + tax%) per option; RULE B kept
--       behind quote.total_rule = 'options_only'.
--   D2  sales tax is a PERCENT (sales_tax_pct); the $ amount is computed.
--   D3  option-level approval: approved_section_id + section.locked.
--   D4  rounds: quote_section.round; a new round opens after client approval.
--   D6  client decision states: client_approved / client_declined.
--   D7  payment method CODES (zelle/ach/credit/check/cashapp).
--   D8  payment_address jsonb (method-specific payout details).
--   D9  vendor carries the technician compliance flags (W9 / COI / blacklist).
--   D10 soft delete with reason + two-person pending_delete on processed rows.
--   D11 outbox for the ClickUp / Teams adapters (local no-op drains it later).
--   D12 line types fee + discount.
--   D14 `payable` is KEPT: the Messages correlation (messages.ts) joins on it.
--
-- Permissions (0015 tree):
--   payments:approve          approve / reject            — unchanged from 0016
--   payments/process:edit     pay / change method / delete — AP and admin (0016)
--   payments/process:delete   confirm or keep a pending delete — admin only (NEW)
--
-- Postgres-16 compatible; the runner passes this file WHOLE to db.exec().
-- ============================================================================

-- ── QUOTE ───────────────────────────────────────────────────────────────────
ALTER TABLE quote DROP CONSTRAINT IF EXISTS quote_status_check;
ALTER TABLE quote ADD CONSTRAINT quote_status_check
  CHECK (status IN ('draft','pending_approval','approved','sent','client_approved','client_declined'));

ALTER TABLE quote
  ADD COLUMN IF NOT EXISTS sales_tax_pct        numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_rule           text NOT NULL DEFAULT 'incurred_plus_option',
  ADD COLUMN IF NOT EXISTS bill_to              text,
  ADD COLUMN IF NOT EXISTS is_cost_tbd          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_section_id  uuid,
  ADD COLUMN IF NOT EXISTS client_decided_at    timestamptz,
  ADD COLUMN IF NOT EXISTS client_decided_by    uuid REFERENCES principal(id),
  ADD COLUMN IF NOT EXISTS client_decision_note text,
  ADD COLUMN IF NOT EXISTS client_approved_on_site boolean NOT NULL DEFAULT false;

ALTER TABLE quote ADD CONSTRAINT quote_total_rule_check
  CHECK (total_rule IN ('incurred_plus_option','options_only'));

-- ── QUOTE SECTION — rounds, lock, option approval ───────────────────────────
ALTER TABLE quote_section
  ADD COLUMN IF NOT EXISTS round          int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS locked         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_at    timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by    uuid REFERENCES principal(id),
  ADD COLUMN IF NOT EXISTS rejection_note text,
  ADD COLUMN IF NOT EXISTS deleted_at     timestamptz;
CREATE INDEX IF NOT EXISTS quote_section_round_idx ON quote_section(quote_id, round, position);

ALTER TABLE quote ADD CONSTRAINT quote_approved_section_fk
  FOREIGN KEY (approved_section_id) REFERENCES quote_section(id) ON DELETE SET NULL;

-- ── QUOTE LINE — fee / discount, integer day ────────────────────────────────
ALTER TABLE quote_line DROP CONSTRAINT IF EXISTS quote_line_line_type_check;
ALTER TABLE quote_line ADD CONSTRAINT quote_line_line_type_check
  CHECK (line_type IN ('service','labor','part','material','fee','discount'));

ALTER TABLE quote_line ADD COLUMN IF NOT EXISTS day int;
UPDATE quote_line
   SET day = NULLIF(regexp_replace(day_value, '\D', '', 'g'), '')::int
 WHERE day IS NULL AND day_value IS NOT NULL;

-- ── QUOTE REVISION SNAPSHOT — pricing history at every send / decision ──────
CREATE TABLE IF NOT EXISTS quote_revision_snapshot (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id   uuid NOT NULL REFERENCES quote(id) ON DELETE CASCADE,
  rev        int  NOT NULL,
  status     text NOT NULL,
  snapshot   jsonb NOT NULL,
  created_by uuid REFERENCES principal(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quote_revision_snapshot_idx ON quote_revision_snapshot(quote_id, created_at DESC);

-- ── LABOR RATE — per (billing entity, FM, trade), Yoda LaborRate ────────────
CREATE TABLE IF NOT EXISTS labor_rate (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_entity        text,
  fm                    text,
  trade                 text,
  tech_rate             numeric(12,2),
  helper_rate           numeric(12,2),
  trip_rate             numeric(12,2),
  afterhours_rate       numeric(12,2),
  holiday_rate          numeric(12,2),
  is_sales_tax_required boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS labor_rate_combo_uq
  ON labor_rate (COALESCE(billing_entity,''), COALESCE(fm,''), COALESCE(trade,''));
CREATE TRIGGER labor_rate_touch BEFORE UPDATE ON labor_rate
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── SALES TAX RATE — ZIP → combined % cache (RapidAPI seam) ─────────────────
CREATE TABLE IF NOT EXISTS sales_tax_rate (
  zip        text PRIMARY KEY,
  pct        numeric(6,3) NOT NULL,
  source     text NOT NULL DEFAULT 'manual',
  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- ── VENDOR — technician compliance (Yoda Technician) ────────────────────────
ALTER TABLE vendor
  ADD COLUMN IF NOT EXISTS email                text,
  ADD COLUMN IF NOT EXISTS is_w9_present        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_blacklisted       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blacklist_reason     text,
  ADD COLUMN IF NOT EXISTS insurance_expires_on date,
  ADD COLUMN IF NOT EXISTS notes                text;
CREATE INDEX IF NOT EXISTS vendor_phone_idx ON vendor(phone);

-- ── PAYMENT REQUEST — the full Yoda lifecycle ───────────────────────────────
ALTER TABLE payment_request
  ADD COLUMN IF NOT EXISTS payment_address     jsonb,
  ADD COLUMN IF NOT EXISTS recipient_phone     text,
  ADD COLUMN IF NOT EXISTS recipient_is_store  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS needs_w9            boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pending_delete      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS delete_requested_by uuid REFERENCES principal(id),
  ADD COLUMN IF NOT EXISTS delete_reason       text,
  ADD COLUMN IF NOT EXISTS deleted_at          timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by          uuid REFERENCES principal(id),
  ADD COLUMN IF NOT EXISTS posted_message_plain text,
  ADD COLUMN IF NOT EXISTS attachment_id       uuid REFERENCES attachment(id) ON DELETE SET NULL;
-- 0016 bumps updated_at by hand in its UPDATEs; the trigger makes every writer
-- honest (the parity service touches the row from several places).
CREATE TRIGGER payment_request_touch BEFORE UPDATE ON payment_request
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS payment_request_vendor_idx ON payment_request(vendor_id, created_at);

-- D7: normalise the S4 free-text labels to the Yoda method codes, then pin them.
UPDATE payment_request SET method = CASE
  WHEN lower(method) IN ('zelle')                              THEN 'zelle'
  WHEN lower(method) IN ('ach','ach transfer')                 THEN 'ach'
  WHEN lower(method) IN ('check','cheque')                     THEN 'check'
  WHEN lower(method) IN ('credit','company card','card')       THEN 'credit'
  WHEN lower(method) IN ('cashapp','cash app')                 THEN 'cashapp'
  ELSE lower(method) END;
ALTER TABLE payment_request ADD CONSTRAINT payment_request_method_check
  CHECK (method IN ('zelle','ach','credit','check','cashapp'));

-- Retire the hand-off: a row parked at sent_to_yoda is, for this flow, an
-- approved row that has not been paid yet. The CHECK (0016) keeps the value
-- legal so nothing older than this migration can ever fail to load.
UPDATE payment_request SET status = 'approved' WHERE status = 'sent_to_yoda';

-- ── OUTBOX — integration seam (ClickUp field/comments, Teams posts) ─────────
CREATE TABLE IF NOT EXISTS outbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    uuid,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  attempts     int NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(status, created_at);

-- ── ROLES — the AP seat (Yoda PaymentUsersPolicy) ───────────────────────────
-- The `ap` role exists since 0005 and 0016 granted it payments/process:edit.
-- Only an admin may CONFIRM a delete on a processed row (D10, Yoda
-- PaymentAdmins): grant the `delete` action on the same path to admin alone.
-- Roles are never truncated by the seed, so this grant lives here ONLY.
UPDATE role
   SET permissions = jsonb_set(
         permissions,
         '{payments/process}',
         COALESCE(permissions -> 'payments/process', '{}'::jsonb)
           || jsonb_build_object('delete', code = 'admin'),
         true)
 WHERE code <> 'service';

-- One AP principal so a migrated-but-not-reseeded pgdata has somebody who can
-- pay. seed.ts creates the same seat (keep in step).
INSERT INTO principal (kind, display_name, email, role, initials, status, is_super_admin)
SELECT 'human', 'Dana Reyes', 'ap@seamlessfm.example', 'ap', 'DR', 'invited', false
 WHERE NOT EXISTS (SELECT 1 FROM principal WHERE role = 'ap');
