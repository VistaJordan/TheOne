-- 0048 · The quote as a document (Facilio parity, batch 5).
--
-- A quote has been a set of numbers on a screen with a work-order number for
-- a title. A client is sent a DOCUMENT: it has its own number, it says what
-- kind of document it is, who it is billed to and where the work ships, and
-- each line carries a unit of measure, a tax rate and a markup as well as a
-- price. This migration gives the record those columns; the builder fills
-- them and the print view (Quote › Print / PDF) lays them out.
--
--   the number   Q-SFM-2026-0001 — per billing entity per year, from its own
--                sequence, issued when the quote is created and never reused
--                (the invoice number's rules, 0045). Existing quotes are
--                numbered below in the order they were created, so nothing
--                already sent goes without one.
--   the rates    a quote raised under a contract (0046) snapshots the
--                overtime multiplier it was priced with. NULL means the
--                house default (×1.5, services/quotes.ts OT_MULTIPLIER): a
--                quote priced before this migration keeps computing exactly
--                what it computed.
--   per line     uom is free text ('hr', 'ea', 'trip'); tax_pct and
--                markup_pct default to 0 so every existing line's amount is
--                unchanged.

ALTER TABLE quote
  ADD COLUMN IF NOT EXISTS number         text UNIQUE,
  ADD COLUMN IF NOT EXISTS document_type  text NOT NULL DEFAULT 'quote',
  ADD COLUMN IF NOT EXISTS currency       text NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS bill_to        text,
  ADD COLUMN IF NOT EXISTS ship_to        text,
  ADD COLUMN IF NOT EXISTS contract_id    uuid REFERENCES contract(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ot_multiplier  numeric(6,3);

ALTER TABLE quote DROP CONSTRAINT IF EXISTS quote_document_type_check;
ALTER TABLE quote
  ADD CONSTRAINT quote_document_type_check
  CHECK (document_type IN ('quote', 'proposal', 'estimate'));

ALTER TABLE quote_line
  ADD COLUMN IF NOT EXISTS uom         text,
  ADD COLUMN IF NOT EXISTS tax_pct     numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS markup_pct  numeric(5,2) NOT NULL DEFAULT 0;

-- One sequence per billing entity per year, claimed with an UPDATE inside the
-- creating transaction (0045's pattern) so two people pressing "Create quote"
-- in the same second take different numbers.
CREATE TABLE IF NOT EXISTS quote_sequence (
  billing_entity text NOT NULL,
  year           int  NOT NULL,
  next_number    int  NOT NULL DEFAULT 1,
  PRIMARY KEY (billing_entity, year)
);

-- Number every quote that exists, oldest first, per entity and year of
-- creation. The sequence rows are left pointing past the last number issued.
DO $$
DECLARE
  r RECORD;
  n int;
  ent text;
  yr int;
BEGIN
  FOR r IN
    SELECT q.id, q.created_at, t.billing_entity
      FROM quote q JOIN task t ON t.id = q.task_id
     WHERE q.number IS NULL
     ORDER BY q.created_at, q.id
  LOOP
    ent := COALESCE(NULLIF(upper(regexp_replace(COALESCE(r.billing_entity, ''), '[^A-Za-z0-9]', '', 'g')), ''), 'Q');
    yr := EXTRACT(YEAR FROM r.created_at)::int;
    INSERT INTO quote_sequence (billing_entity, year, next_number)
      VALUES (ent, yr, 1)
      ON CONFLICT (billing_entity, year) DO NOTHING;
    UPDATE quote_sequence SET next_number = next_number + 1
      WHERE billing_entity = ent AND year = yr
      RETURNING next_number - 1 INTO n;
    UPDATE quote SET number = 'Q-' || ent || '-' || yr::text || '-' || lpad(n::text, 4, '0')
      WHERE id = r.id;
  END LOOP;
END $$;
