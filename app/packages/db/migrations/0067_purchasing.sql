-- 0067 · Financials, the rest (Facilio parity): purchase requests, requests
-- for quotation with the vendor quotes they collect, purchase orders, the tax
-- rate table, document templates, and the owner-side trio — cost centers,
-- AFEs (authorizations for expenditure) and budgets.
--
-- Everything is additive, and nothing here changes a number that exists:
--   · a purchase order does NOT feed a work order's `34. Cost`. The Cost of a
--     work order still has exactly one source; a purchase order is a document
--     beside it.
--   · tax rates are a list to pick from. No quote or invoice on file is
--     recomputed; a rate only does something when a person picks it on a new
--     purchase order or presses "apply" on a quote they are editing.
--   · a document template adds a letterhead, terms and a footer to the PRINTED
--     quote, invoice and purchase order. With no template the quote prints
--     exactly as it did.
--   · going over a budget or an AFE warns; it never blocks.
--
-- Configuration tables (tax_rate, doc_template, cost_center, afe, budget)
-- carry no FK to principal, task or vendor, so a re-seed leaves them alone.

-- ── Tax rates ───────────────────────────────────────────────────────────────

CREATE TABLE tax_rate (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  -- Percent: 8.25 = 8.25 %.
  rate       numeric(6,3) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  state      text,
  is_default boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tax_rate_name_key ON tax_rate (lower(name));

-- ── Document templates ──────────────────────────────────────────────────────

CREATE TABLE doc_template (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('quote', 'invoice', 'purchase_order')),
  name            text NOT NULL,
  -- The letterhead: who the document is from, and how to reach them.
  company_name    text,
  company_details text,
  -- Printed under the totals.
  terms           text,
  -- Printed at the foot of the page.
  footer          text,
  is_default      boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX doc_template_one_default ON doc_template (kind) WHERE is_default;

-- ── Cost centers, AFEs, budgets ─────────────────────────────────────────────

CREATE TABLE cost_center (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL,
  name        text NOT NULL,
  client      text,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cost_center_code_key ON cost_center (lower(code));

CREATE TABLE afe (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  afe_number     text NOT NULL,
  title          text NOT NULL,
  cost_center_id uuid REFERENCES cost_center(id) ON DELETE SET NULL,
  amount         numeric(14,2) NOT NULL CHECK (amount >= 0),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  valid_from     date,
  valid_to       date,
  note           text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX afe_number_key ON afe (lower(afe_number));

CREATE TABLE budget (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_center_id uuid NOT NULL REFERENCES cost_center(id) ON DELETE CASCADE,
  year           int NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  amount         numeric(14,2) NOT NULL CHECK (amount >= 0),
  note           text,
  UNIQUE (cost_center_id, year)
);

-- A work order can be filed under a cost center and cite an AFE.
ALTER TABLE task
  ADD COLUMN cost_center_id uuid REFERENCES cost_center(id) ON DELETE SET NULL,
  ADD COLUMN afe_id         uuid REFERENCES afe(id) ON DELETE SET NULL;
CREATE INDEX task_cost_center_idx ON task (cost_center_id) WHERE cost_center_id IS NOT NULL;

-- ── Purchase requests ───────────────────────────────────────────────────────

CREATE SEQUENCE purchase_request_seq START 1001;
CREATE TABLE purchase_request (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_number      text NOT NULL UNIQUE DEFAULT ('PR-' || nextval('purchase_request_seq')),
  task_id        uuid REFERENCES task(id) ON DELETE SET NULL,
  title          text NOT NULL,
  reason         text,
  needed_by      date,
  vendor_id      uuid REFERENCES vendor(id) ON DELETE SET NULL,
  vendor_name    text,
  cost_center_id uuid REFERENCES cost_center(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'ordered', 'cancelled')),
  requested_by   uuid,
  submitted_at   timestamptz,
  decided_by     uuid,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_request_task_idx ON purchase_request (task_id);
CREATE INDEX purchase_request_status_idx ON purchase_request (status, created_at DESC);

CREATE TABLE purchase_request_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    uuid NOT NULL REFERENCES purchase_request(id) ON DELETE CASCADE,
  position      int NOT NULL DEFAULT 0,
  description   text NOT NULL,
  qty           numeric(12,2) NOT NULL DEFAULT 1,
  unit          text NOT NULL DEFAULT 'each',
  est_unit_cost numeric(12,2)
);
CREATE INDEX purchase_request_line_idx ON purchase_request_line (request_id, position);

-- ── Requests for quotation, and the quotes vendors send back ────────────────

CREATE SEQUENCE rfq_seq START 1001;
CREATE TABLE rfq (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_number       text NOT NULL UNIQUE DEFAULT ('RFQ-' || nextval('rfq_seq')),
  task_id          uuid REFERENCES task(id) ON DELETE SET NULL,
  request_id       uuid REFERENCES purchase_request(id) ON DELETE SET NULL,
  title            text NOT NULL,
  description      text,
  due_on           date,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'closed', 'awarded', 'cancelled')),
  awarded_quote_id uuid,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rfq_task_idx ON rfq (task_id);

CREATE TABLE rfq_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id      uuid NOT NULL REFERENCES rfq(id) ON DELETE CASCADE,
  position    int NOT NULL DEFAULT 0,
  description text NOT NULL,
  qty         numeric(12,2) NOT NULL DEFAULT 1,
  unit        text NOT NULL DEFAULT 'each'
);
CREATE INDEX rfq_line_idx ON rfq_line (rfq_id, position);

CREATE TABLE rfq_vendor (
  rfq_id     uuid NOT NULL REFERENCES rfq(id) ON DELETE CASCADE,
  vendor_id  uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  invited_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rfq_id, vendor_id)
);

CREATE TABLE vendor_quote (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id      uuid NOT NULL REFERENCES rfq(id) ON DELETE CASCADE,
  vendor_id   uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  -- The vendor's own quote number.
  quote_ref   text,
  -- What the vendor asks for the whole request; the per-line prices, when
  -- they gave them, are in vendor_quote_line and add up to it.
  total       numeric(14,2) NOT NULL DEFAULT 0,
  lead_days   int,
  valid_until date,
  note        text,
  status      text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'selected', 'rejected')),
  received_on date NOT NULL DEFAULT CURRENT_DATE,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, vendor_id)
);

CREATE TABLE vendor_quote_line (
  quote_id    uuid NOT NULL REFERENCES vendor_quote(id) ON DELETE CASCADE,
  rfq_line_id uuid NOT NULL REFERENCES rfq_line(id) ON DELETE CASCADE,
  unit_price  numeric(12,2) NOT NULL,
  PRIMARY KEY (quote_id, rfq_line_id)
);

-- ── Purchase orders ─────────────────────────────────────────────────────────

CREATE SEQUENCE purchase_order_seq START 1001;
CREATE TABLE purchase_order (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number      text NOT NULL UNIQUE DEFAULT ('PO-' || nextval('purchase_order_seq')),
  task_id        uuid REFERENCES task(id) ON DELETE SET NULL,
  vendor_id      uuid REFERENCES vendor(id) ON DELETE SET NULL,
  vendor_name    text NOT NULL,
  request_id     uuid REFERENCES purchase_request(id) ON DELETE SET NULL,
  rfq_id         uuid REFERENCES rfq(id) ON DELETE SET NULL,
  cost_center_id uuid REFERENCES cost_center(id) ON DELETE SET NULL,
  afe_id         uuid REFERENCES afe(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'partially_received', 'received', 'closed', 'cancelled')),
  order_date     date,
  expected_on    date,
  ship_to        text,
  note           text,
  tax_rate_name  text,
  tax_pct        numeric(6,3) NOT NULL DEFAULT 0,
  subtotal       numeric(14,2) NOT NULL DEFAULT 0,
  tax            numeric(14,2) NOT NULL DEFAULT 0,
  total          numeric(14,2) NOT NULL DEFAULT 0,
  created_by     uuid,
  approved_by    uuid,
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_order_task_idx ON purchase_order (task_id);
CREATE INDEX purchase_order_status_idx ON purchase_order (status, created_at DESC);
CREATE INDEX purchase_order_cc_idx ON purchase_order (cost_center_id) WHERE cost_center_id IS NOT NULL;

CREATE TABLE purchase_order_line (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id        uuid NOT NULL REFERENCES purchase_order(id) ON DELETE CASCADE,
  position     int NOT NULL DEFAULT 0,
  description  text NOT NULL,
  qty          numeric(12,2) NOT NULL DEFAULT 1,
  unit         text NOT NULL DEFAULT 'each',
  unit_cost    numeric(12,2) NOT NULL DEFAULT 0,
  received_qty numeric(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX purchase_order_line_idx ON purchase_order_line (po_id, position);

-- ── Who may do what ─────────────────────────────────────────────────────────
-- One section, `purchasing`, with a row per part underneath (unset inherits).
-- Managers, admin and accounts payable work it in full; dispatchers raise
-- requests and read the rest; nobody else sees it. Only fills a role that has
-- not set the section.

UPDATE role SET permissions = permissions
    || jsonb_build_object('purchasing', jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true, 'approve', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am', 'ap') AND NOT (permissions ? 'purchasing');

UPDATE role SET permissions = permissions
    || jsonb_build_object('purchasing', jsonb_build_object('view', true, 'create', false, 'edit', false, 'delete', false, 'approve', false),
                          'purchasing/requests', jsonb_build_object('view', true, 'create', true, 'edit', true, 'approve', false),
                          'purchasing/budgets', jsonb_build_object('view', false, 'edit', false))
 WHERE code IN ('om', 'om_probation', 'senior_om', 'ops_coord', 'oa') AND NOT (permissions ? 'purchasing');

UPDATE role SET permissions = permissions
    || jsonb_build_object('purchasing', jsonb_build_object('view', false, 'create', false, 'edit', false, 'delete', false, 'approve', false))
 WHERE NOT (permissions ? 'purchasing');
