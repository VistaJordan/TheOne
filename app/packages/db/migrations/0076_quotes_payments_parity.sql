-- ============================================================================
-- 0076_quotes_payments_parity.sql — Yoda parity for quotes and technician
-- payments (Jeff Soren's port, D1–D16; his rules are the source of truth).
--
-- Written as 0028_quotes_payments_v2 on Primary-Updates; renumbered and
-- adapted for phase-0-ground, where 0029–0075 already sit underneath it:
--   · the vendor record already carries the technician's compliance since
--     0057 (w9_received, blacklisted + reason, vendor_expiry, email, notes) —
--     the payment flow READS those instead of adding a second set of columns;
--   · quote.bill_to exists since 0048 (ADD COLUMN IF NOT EXISTS is a no-op);
--   · the demo AP principal ("Dana Reyes") is NOT inserted here: production
--     gets real people from Admin › Users. seed.ts still creates it locally.
--
-- Decisions applied (product/quotes-payments-gap-analysis.md §5):
--   D1  grand total = (incurred + option) × (1 + tax%) per option; RULE B kept
--       behind quote.total_rule = 'options_only'.
--   D2  sales tax is a PERCENT (sales_tax_pct); the $ amount is computed.
--   D3  option-level approval: approved_section_id + section.locked.
--   D4  rounds: quote_section.round; a new round opens after the client decides.
--   D6  client decision states: client_approved / client_declined.
--   D7  payment method CODES (zelle/ach/credit/check/cashapp).
--   D8  payment_address jsonb (method-specific payout details).
--   D10 soft delete with reason + two-person pending_delete on processed rows.
--   D11 outbox for the ClickUp / Teams adapters (nothing drains it yet).
--   D12 line types fee + discount.
--
-- RETIRES the 0022 Yoda hand-off: this flow IS the Yoda payment flow, so a
-- row parked at `sent_to_yoda` folds back to `approved` (approved, not yet
-- paid). The value stays legal in the CHECK so old audit rows still read.
--
-- Cost follows PAID requests from here on (shared/moneyRules.ts) and is
-- re-derived on the next payment move. Checked on production before this
-- ran (2026-10-13): no Cost had been written by the system yet, no quote
-- carried a sales-tax amount and no row sat at sent_to_yoda — so no data
-- needs re-pricing here.
--
-- Permissions (0021 tree):
--   payments:approve          approve / reject                — unchanged (0022)
--   payments/process:edit     pay / change method / delete    — AP and admin (0022)
--   payments/process:delete   confirm or keep a pending delete — admin only (NEW)
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

ALTER TABLE quote DROP CONSTRAINT IF EXISTS quote_total_rule_check;
ALTER TABLE quote ADD CONSTRAINT quote_total_rule_check
  CHECK (total_rule IN ('incurred_plus_option','options_only'));

-- The S4 dollar `sales_tax` column stays (old snapshots name it) but nothing
-- reads it any more: the tax is sales_tax_pct × the priced work.

-- ── QUOTE SECTION — rounds, lock, option approval ───────────────────────────
ALTER TABLE quote_section
  ADD COLUMN IF NOT EXISTS round          int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS locked         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_at    timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by    uuid REFERENCES principal(id),
  ADD COLUMN IF NOT EXISTS rejection_note text,
  ADD COLUMN IF NOT EXISTS deleted_at     timestamptz;
CREATE INDEX IF NOT EXISTS quote_section_round_idx ON quote_section(quote_id, round, position);

ALTER TABLE quote DROP CONSTRAINT IF EXISTS quote_approved_section_fk;
ALTER TABLE quote ADD CONSTRAINT quote_approved_section_fk
  FOREIGN KEY (approved_section_id) REFERENCES quote_section(id) ON DELETE SET NULL;

-- ── QUOTE LINE — fee / discount, integer day ────────────────────────────────
ALTER TABLE quote_line DROP CONSTRAINT IF EXISTS quote_line_line_type_check;
ALTER TABLE quote_line ADD CONSTRAINT quote_line_line_type_check
  CHECK (line_type IN ('service','labor','part','material','fee','discount'));

ALTER TABLE quote_line ADD COLUMN IF NOT EXISTS day int;
UPDATE quote_line
   SET day = NULLIF(regexp_replace(day_value, '\D', '', 'g'), '')::int
 WHERE day IS NULL AND day_value IS NOT NULL AND regexp_replace(day_value, '\D', '', 'g') ~ '^\d{1,4}$';

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
DROP TRIGGER IF EXISTS labor_rate_touch ON labor_rate;
CREATE TRIGGER labor_rate_touch BEFORE UPDATE ON labor_rate
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── SALES TAX RATE — ZIP → combined % cache (RapidAPI seam) ─────────────────
CREATE TABLE IF NOT EXISTS sales_tax_rate (
  zip        text PRIMARY KEY,
  pct        numeric(6,3) NOT NULL,
  source     text NOT NULL DEFAULT 'manual',
  fetched_at timestamptz NOT NULL DEFAULT now()
);

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
-- 0022 bumps updated_at by hand in its UPDATEs; the trigger makes every writer
-- honest (the parity service touches the row from several places).
DROP TRIGGER IF EXISTS payment_request_touch ON payment_request;
CREATE TRIGGER payment_request_touch BEFORE UPDATE ON payment_request
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS payment_request_vendor_idx ON payment_request(vendor_id, created_at);

-- D7: normalise the free-text labels (Zelle, ACH transfer, Check, Company
-- card, Cash App) to the Yoda method codes, then pin them.
UPDATE payment_request SET method = CASE
  WHEN lower(method) IN ('zelle')                              THEN 'zelle'
  WHEN lower(method) IN ('ach','ach transfer')                 THEN 'ach'
  WHEN lower(method) IN ('check','cheque')                     THEN 'check'
  WHEN lower(method) IN ('credit','company card','card')       THEN 'credit'
  WHEN lower(method) IN ('cashapp','cash app')                 THEN 'cashapp'
  ELSE 'zelle' END
 WHERE method IS DISTINCT FROM CASE
  WHEN lower(method) IN ('zelle')                              THEN 'zelle'
  WHEN lower(method) IN ('ach','ach transfer')                 THEN 'ach'
  WHEN lower(method) IN ('check','cheque')                     THEN 'check'
  WHEN lower(method) IN ('credit','company card','card')       THEN 'credit'
  WHEN lower(method) IN ('cashapp','cash app')                 THEN 'cashapp'
  ELSE 'zelle' END;
ALTER TABLE payment_request DROP CONSTRAINT IF EXISTS payment_request_method_check;
ALTER TABLE payment_request ADD CONSTRAINT payment_request_method_check
  CHECK (method IN ('zelle','ach','credit','check','cashapp'));

-- Retire the hand-off: a row parked at sent_to_yoda is, for this flow, an
-- approved row that has not been paid yet.
UPDATE payment_request SET status = 'approved' WHERE status = 'sent_to_yoda';

-- ── OUTBOX — integration seam (ClickUp field/comments, Teams posts) ─────────
-- Distinct from comment_delivery (0052, the client-CMMS message outbox).
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

-- ── ROLES — the second person on a processed row's delete ───────────────────
-- Only an admin may CONFIRM a delete on a processed row (D10, Yoda
-- PaymentAdmins): grant the `delete` action on payments/process to admin
-- alone. Roles are never truncated by the seed, so this grant lives here ONLY.
UPDATE role
   SET permissions = jsonb_set(
         permissions,
         '{payments/process}',
         COALESCE(permissions -> 'payments/process', '{}'::jsonb)
           || jsonb_build_object('delete', code = 'admin'),
         true)
 WHERE code <> 'service';
