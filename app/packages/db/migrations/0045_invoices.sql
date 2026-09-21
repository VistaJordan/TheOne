-- 0045 · Invoices that exist.
--
-- Receivables › Invoicing has been a front end with nothing behind it: the
-- ticks and the Ready → Invoiced → Paid stages lived in React state and were
-- gone on reload, and "Invoice #" was a number derived from the work order's
-- id rather than one this business had ever issued. That is the last hole in
-- the money story — quote, payment and audit are all real records; the bill to
-- the client was not.
--
-- Decisions taken with Elise, 2026-09-20:
--   one invoice per work order.  Consolidating a month of jobs onto one
--       invoice is a real thing clients ask for, but it turns every screen
--       invoice-first; when it is wanted it becomes a join table, not a
--       rewrite of this one.
--   the amount starts from the approved quote  (grand total + incurred) and
--       stays editable until the invoice is sent. AR is the last check, and a
--       quote that was right in July is not always right in September.
--   the number is issued per billing entity and year  — SFM-2026-0001,
--       BKR-2026-0001 — because the entities bill as separate companies and a
--       shared sequence would interleave them.
--
-- The line items are a snapshot, not a view of the quote. A sent invoice must
-- keep saying what it said when it was sent, whatever the quote does
-- afterwards; that is the whole point of issuing one.

CREATE TABLE IF NOT EXISTS invoice (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  -- Issued on first save, from the per-entity sequence below. Never reused:
  -- a voided invoice keeps its number, because the client has seen it.
  number          text NOT NULL UNIQUE,
  -- 'SFM' / 'BKR' / … — task.billing_entity at the moment of issue, kept here
  -- so the number and the entity can never drift apart.
  billing_entity  text,
  client          text,
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  -- What the client is billed, and what it cost us — the second is carried so
  -- margin survives on the invoice even if the work order is edited later.
  subtotal        numeric(12,2) NOT NULL DEFAULT 0,
  tax             numeric(12,2) NOT NULL DEFAULT 0,
  discount        numeric(12,2) NOT NULL DEFAULT 0,
  total           numeric(12,2) NOT NULL DEFAULT 0,
  cost            numeric(12,2),
  note            text,
  -- The stamps that matter to collections.
  issued_at       timestamptz,
  due_at          date,
  paid_at         timestamptz,
  paid_reference  text,
  created_by      uuid REFERENCES principal(id) ON DELETE SET NULL,
  sent_by         uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoice_task_idx   ON invoice(task_id);
CREATE INDEX IF NOT EXISTS invoice_status_idx ON invoice(status);

CREATE TABLE IF NOT EXISTS invoice_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  -- 'service' | 'labor' | 'part' | 'material' | 'trip' | 'tax' — free text so
  -- a new kind of line never needs a migration.
  kind        text NOT NULL DEFAULT 'service',
  description text NOT NULL,
  quantity    numeric(12,2) NOT NULL DEFAULT 1,
  unit_price  numeric(12,2) NOT NULL DEFAULT 0,
  amount      numeric(12,2) NOT NULL DEFAULT 0,
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoice_line_invoice_idx ON invoice_line(invoice_id, position);

-- One sequence per billing entity per year. A row is claimed with an UPDATE
-- inside the issuing transaction, so two people pressing "Create invoice" at
-- the same second cannot take the same number.
CREATE TABLE IF NOT EXISTS invoice_sequence (
  billing_entity text NOT NULL,
  year           int  NOT NULL,
  next_number    int  NOT NULL DEFAULT 1,
  PRIMARY KEY (billing_entity, year)
);

CREATE TRIGGER invoice_touch BEFORE UPDATE ON invoice
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER invoice_line_touch BEFORE UPDATE ON invoice_line
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Who may bill. `invoicing` has sat in the permission tree since 0015 marked
-- "module not live yet"; it is live now. AR owns the queue, Admin and the
-- Account Manager can see and raise one, and approving is the act of sending
-- it to the client. Only where the path is not already set, so a Roles-screen
-- decision survives. Role rows are migration-owned (seed.ts never truncates
-- `role`), so nothing here needs mirroring in the seed.
UPDATE role
   SET permissions = permissions
     || jsonb_build_object('invoicing', jsonb_build_object(
          'view', true, 'create', true, 'edit', true, 'approve', true))
 WHERE code IN ('admin', 'ar')
   AND NOT (permissions ? 'invoicing');

UPDATE role
   SET permissions = permissions
     || jsonb_build_object('invoicing', jsonb_build_object('view', true, 'create', true))
 WHERE code IN ('am', 'tl')
   AND NOT (permissions ? 'invoicing');
