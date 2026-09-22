-- 0053 · The Financial tab, the rest of BRD §6.4.
--
-- Three things were still missing after 0045–0048:
--
--   1. "Vendor payments can be automated from the contract held with the
--      vendor and the hours spent on site." A contract has only ever been a
--      CLIENT rate card. It now has a `party`: 'client' (what we bill the
--      client) or 'vendor' (what a vendor bills us). A vendor contract is
--      matched to a work order by the vendor's name — the technician on the
--      latest visit, or the payee on its payment request — because vendors
--      are still names, not records, on a work order.
--
--   2. "If enabled, an invoice is generated automatically once the work order
--      is completed; confirming it creates the invoice and files it in the
--      Invoices section." `contract.auto_invoice` is the switch. When a work
--      order moves into the done group and a covering contract has it on,
--      a `billing_proposal` is written: the lines the contract implies (hours
--      on site × rate, trip charge × visits — or the approved quote's lines
--      for a client invoice), waiting on a person. Confirming creates the
--      invoice (client party) or the vendor bill (vendor party) from the
--      proposal's lines; dismissing files nothing. The proposal is a separate
--      row on purpose: an invoice number is issued only for a document a
--      person has agreed to, and the Invoices queue holds documents, not
--      guesses.
--
--   3. "Invoice contents: … work order name and location, vendor details."
--      The invoice snapshots the work order's title, its site line and the
--      vendor on the job when it is raised, and remembers which contract
--      priced it. A vendor bill remembers its contract too.

ALTER TABLE contract
  ADD COLUMN IF NOT EXISTS party text NOT NULL DEFAULT 'client'
    CHECK (party IN ('client', 'vendor'));
ALTER TABLE contract
  ADD COLUMN IF NOT EXISTS vendor_name text;
ALTER TABLE contract
  ADD COLUMN IF NOT EXISTS auto_invoice boolean NOT NULL DEFAULT false;

ALTER TABLE invoice ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS site text;
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS vendor_name text;
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS vendor_contact text;
ALTER TABLE invoice
  ADD COLUMN IF NOT EXISTS contract_id uuid REFERENCES contract(id) ON DELETE SET NULL;

ALTER TABLE vendor_bill
  ADD COLUMN IF NOT EXISTS contract_id uuid REFERENCES contract(id) ON DELETE SET NULL;

-- What a contract proposes to bill once the work is done, until someone says
-- yes or no. `lines` is the same shape the invoice and vendor-bill line
-- tables take (kind, description, quantity, unit_price), so confirming is a
-- copy, never a recomputation — the figures a person saw are the figures
-- that get filed.
CREATE TABLE IF NOT EXISTS billing_proposal (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  -- 'invoice' (to the client) or 'vendor_bill' (from the vendor).
  kind          text NOT NULL CHECK (kind IN ('invoice', 'vendor_bill')),
  contract_id   uuid REFERENCES contract(id) ON DELETE SET NULL,
  contract_name text NOT NULL,
  vendor_name   text,
  basis         text NOT NULL,
  hours         numeric(8,2) NOT NULL DEFAULT 0,
  visits        int NOT NULL DEFAULT 0,
  lines         jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal      numeric(12,2) NOT NULL DEFAULT 0,
  tax           numeric(12,2) NOT NULL DEFAULT 0,
  total         numeric(12,2) NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'confirmed', 'dismissed')),
  -- The invoice or vendor bill the confirmation created.
  result_id     uuid,
  decided_by    uuid REFERENCES principal(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_proposal_task_idx   ON billing_proposal(task_id, kind);
CREATE INDEX IF NOT EXISTS billing_proposal_status_idx ON billing_proposal(status, created_at DESC);

CREATE TRIGGER billing_proposal_touch BEFORE UPDATE ON billing_proposal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
