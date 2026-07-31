-- ============================================================================
-- 0003_quotes.sql — Sprint 4: the quote builder (Yoda replacement) and the
-- technician payment request (PPR replacement).
--
-- Two independent object graphs, both hanging off `task`:
--
--   quote ─┬─ quote_section (kind='incurred' | 'option') ─── quote_line
--          └─ one row per work order (task_id is UNIQUE — "one quote per WO
--             for now"; revisions are tracked by quote.rev, not by extra rows)
--
--   payment_request — a flat AP request, one row per submission.
--
-- MONEY IS NEVER STORED AS AN AMOUNT. quote_line holds qty / rate / ot only;
-- every amount, subtotal, option total and grand total is computed server-side
-- by computeQuoteTotals() (apps/api/src/services/quotes.ts) so the arithmetic
-- has exactly one home. Money that IS stored is manual input the operator typed:
-- quote.sales_tax (manual numeric, derivation logic imported later) and
-- quote.total_cost (our cost, manual).
--
-- Postgres-16 compatible; the runner passes this file WHOLE to db.exec().
-- ============================================================================

-- ── QUOTE — one per work order ──────────────────────────────────────────────
-- status is the lifecycle from product/quotes-payments.md §1:
--   draft → pending_approval → approved → sent   (reject sends it back to draft)
-- summary_pinned NULL means "auto-generate the client text from the narratives,
-- line items and totals on every read"; a non-NULL value is the operator's
-- hand-edited text and stops the auto-sync (comp: "Edit text pins a manual
-- version").
CREATE TABLE quote (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          uuid NOT NULL UNIQUE REFERENCES task(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','pending_approval','approved','sent')),
  rev              int  NOT NULL DEFAULT 1,
  sales_tax        numeric(12,2) NOT NULL DEFAULT 0,   -- manual input, default 0
  total_cost       numeric(12,2),                      -- manual "our cost"
  specs            text,                               -- internal, never sent to the client
  note_to_customer text,                               -- client-visible, appended to the summary
  summary_pinned   text,                               -- NULL = auto-generate
  created_by       uuid NOT NULL REFERENCES principal(id),
  approved_by      uuid REFERENCES principal(id),
  sent_by          uuid REFERENCES principal(id),
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quote_status_idx ON quote(status);
CREATE TRIGGER quote_touch BEFORE UPDATE ON quote
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── QUOTE SECTION — INCURRED (work already performed) or an OPTION ──────────
-- `name` is the human title of the section as typed in the builder
-- ("Condenser fan motor + start kit replacement"). The A / B / C option LABEL
-- is NOT stored: it is derived from `position` among the option sections, so
-- deleting Option A promotes B to A with no data migration.
--
-- scope_lines is the "Required is to…" list — a JSONB ARRAY OF STRINGS, stored
-- whole because it is only ever read and rewritten whole (same reasoning as
-- quo_call.transcript in 0002).
CREATE TABLE quote_section (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id           uuid NOT NULL REFERENCES quote(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('incurred','option')),
  name               text,
  narrative_reported text,                               -- "Tech reported that…"
  scope_lines        jsonb NOT NULL DEFAULT '[]'::jsonb, -- ["Replace the…", …]
  include_in_summary boolean NOT NULL DEFAULT true,
  position           int NOT NULL DEFAULT 0
);
CREATE INDEX quote_section_quote_idx ON quote_section(quote_id, position);

-- ── QUOTE LINE — one row of an option's / the incurred section's table ──────
-- amount = qty × rate × (ot ? 1.5 : 1), COMPUTED, never stored (see header).
-- day_value stores the Day column's selected value VERBATIM ("Day 1"): its
-- semantics are TBD pending the real quote-builder import, so no math is done
-- on it anywhere in the stack.
CREATE TABLE quote_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id  uuid NOT NULL REFERENCES quote_section(id) ON DELETE CASCADE,
  line_type   text NOT NULL CHECK (line_type IN ('service','labor','part','material')),
  description text NOT NULL,
  qty         numeric(12,2) NOT NULL DEFAULT 0,
  rate        numeric(12,2) NOT NULL DEFAULT 0,
  day_value   text,
  ot          boolean NOT NULL DEFAULT false,   -- overtime = rate × 1.5
  position    int NOT NULL DEFAULT 0
);
CREATE INDEX quote_line_section_idx ON quote_line(section_id, position);

-- ── PAYMENT REQUEST — the AP queue row ──────────────────────────────────────
-- The technician is EITHER a vendor record (vendor_id) OR a manual
-- name + phone pair for a tech who is not in the vendor list — app-enforced,
-- since a CHECK that spans the two shapes would fight future partial saves.
-- recipient_name is the optional "send payment to someone other than the
-- technician" alternate payee.
CREATE TABLE payment_request (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  vendor_id      uuid REFERENCES vendor(id),
  payee_name     text,
  payee_phone    text,
  purpose        text NOT NULL,
  amount         numeric(12,2) NOT NULL,
  method         text NOT NULL,
  note           text,
  recipient_name text,
  status         text NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested','approved','paid','rejected')),
  requested_by   uuid NOT NULL REFERENCES principal(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_request_task_idx ON payment_request(task_id, created_at DESC);

-- ── ROLE BACKFILL ───────────────────────────────────────────────────────────
-- Role gates land before auth (S5): until then the acting principal's
-- `principal.role` IS the permission. The seed writes these same values, so
-- this backfill only matters for a pgdata that is migrated but not re-seeded.
--   quote create/edit : senior_om | atl | tl | am | admin
--   quote approve/send:            atl | tl | am | admin
UPDATE principal SET role = 'admin'     WHERE display_name = 'Jordan Brown';
UPDATE principal SET role = 'atl'       WHERE display_name = 'Elise';
UPDATE principal SET role = 'senior_om' WHERE display_name = 'Matt Hammond';
UPDATE principal SET role = 'am'        WHERE display_name = 'Peter Hope';
UPDATE principal SET role = 'tl'        WHERE display_name = 'Zach Malden';
-- Everyone else who came in as a plain ClickUp 'member' is a dispatcher/OM:
-- explicitly BELOW the quote-builder gate, which is what makes the 403 path
-- testable without inventing a principal.
UPDATE principal SET role = 'om' WHERE kind = 'human' AND role = 'member';
UPDATE principal SET role = 'admin' WHERE kind = 'human' AND role = 'owner';
