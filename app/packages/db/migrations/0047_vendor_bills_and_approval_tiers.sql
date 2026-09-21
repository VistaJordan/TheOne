-- 0047 · Vendor bills (the AP side of invoicing) and approval tiers by amount
--        (rule 6.2.3). Facilio parity, batch 5.
--
-- ── Vendor bills ────────────────────────────────────────────────────────────
-- 0045 made the bill TO the client a record. The bill FROM the vendor — the
-- technician's own invoice for the job — was still a number typed into a
-- payment request's "amount" and nothing else. This is that document: the
-- vendor's invoice number, what it says, when it is due, and whether we have
-- agreed with it. A payment request can then settle a bill rather than a
-- figure somebody remembered.
--
--   received → approved → paid, or disputed (back to received once resolved)
--   or void. Approving is `payments:approve`, the same grant that approves a
--   payment request; paying is `payments/process:edit`, the same grant that
--   marks one paid — AP is one job, not two.

CREATE TABLE IF NOT EXISTS vendor_bill (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  vendor_id       uuid REFERENCES vendor(id) ON DELETE SET NULL,
  -- The name as written on the bill; kept even when vendor_id is set so the
  -- record still reads correctly if the vendor row is renamed later.
  vendor_name     text NOT NULL,
  -- The VENDOR's invoice number, verbatim. Not unique: two vendors can both
  -- send "INV-001".
  bill_number     text,
  received_on     date NOT NULL DEFAULT CURRENT_DATE,
  due_on          date,
  status          text NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received', 'approved', 'paid', 'disputed', 'void')),
  subtotal        numeric(12,2) NOT NULL DEFAULT 0,
  tax             numeric(12,2) NOT NULL DEFAULT 0,
  total           numeric(12,2) NOT NULL DEFAULT 0,
  note            text,
  dispute_note    text,
  approved_by     uuid REFERENCES principal(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  paid_by         uuid REFERENCES principal(id) ON DELETE SET NULL,
  paid_at         timestamptz,
  paid_reference  text,
  -- The payment request that settled it, when one did.
  payment_request_id uuid REFERENCES payment_request(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendor_bill_task_idx   ON vendor_bill(task_id);
CREATE INDEX IF NOT EXISTS vendor_bill_status_idx ON vendor_bill(status, received_on DESC);

CREATE TABLE IF NOT EXISTS vendor_bill_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id     uuid NOT NULL REFERENCES vendor_bill(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'service',
  description text NOT NULL,
  quantity    numeric(12,2) NOT NULL DEFAULT 1,
  unit_price  numeric(12,2) NOT NULL DEFAULT 0,
  amount      numeric(12,2) NOT NULL DEFAULT 0,
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendor_bill_line_bill_idx ON vendor_bill_line(bill_id, position);

CREATE TRIGGER vendor_bill_touch BEFORE UPDATE ON vendor_bill
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER vendor_bill_line_touch BEFORE UPDATE ON vendor_bill_line
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Approval tiers (rule 6.2.3) ─────────────────────────────────────────────
-- "Amount tiers: either of two managers" has been a rule on paper since the
-- BRD and nowhere in the code (memory: payments-tab, 2026-09-07). A tier is a
-- band of amounts and the roles that may say yes inside it. Empty `roles`
-- means "anyone who holds the base permission" — the band exists so the
-- audit row can name it, not to restrict. The bands are configuration, edited
-- from Admin › Settings, and the seed leaves the table alone (the 0012
-- reasoning for holidays and the FM table).
--
-- Enforced at the moment of decision — payments approve, vendor-bill
-- approve, invoice send — as a 403 whose details name the tier, so the
-- button can lock with the reason before the click.

CREATE TABLE IF NOT EXISTS approval_tier (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'payment' | 'vendor_bill' | 'invoice'
  kind        text NOT NULL CHECK (kind IN ('payment', 'vendor_bill', 'invoice')),
  label       text NOT NULL,
  min_amount  numeric(12,2) NOT NULL DEFAULT 0,
  -- NULL = no ceiling.
  max_amount  numeric(12,2),
  -- role.code values. Not an FK for the same reason dashboard.shared_roles
  -- is not: a role that goes away should stop matching, not delete the band.
  roles       text[] NOT NULL DEFAULT '{}',
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approval_tier_kind_idx ON approval_tier(kind, position);

CREATE TRIGGER approval_tier_touch BEFORE UPDATE ON approval_tier
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The bands rule 6.2.3 describes, once, only if nobody has set any.
INSERT INTO approval_tier (kind, label, min_amount, max_amount, roles, position)
SELECT v.kind, v.label, v.min_amount, v.max_amount, v.roles::text[], v.position
  FROM (VALUES
    ('payment',     'Under $500',          0,     500,   '{}',                    0),
    ('payment',     '$500 to $3,000',      500,   3000,  '{tl,atl,am,admin}',     1),
    ('payment',     'Over $3,000',         3000,  NULL,  '{tl,admin}',            2),
    ('vendor_bill', 'Under $500',          0,     500,   '{}',                    0),
    ('vendor_bill', '$500 to $3,000',      500,   3000,  '{tl,atl,am,admin}',     1),
    ('vendor_bill', 'Over $3,000',         3000,  NULL,  '{tl,admin}',            2),
    ('invoice',     'Under $10,000',       0,     10000, '{}',                    0),
    ('invoice',     '$10,000 and above',   10000, NULL,  '{ar,tl,admin}',         1)
  ) AS v(kind, label, min_amount, max_amount, roles, position)
 WHERE NOT EXISTS (SELECT 1 FROM approval_tier);
