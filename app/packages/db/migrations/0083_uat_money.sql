-- 0083 · UAT round 1, Wave A — money integrity (docs/specs/uat-round-1.md).
--
-- The schema half of the Wave A guards; the rules themselves live in
-- packages/shared/src/moneyGuards.ts and the services that call it.
--
--   quote.submitted_by           D2 (#8): who sent the quote for approval —
--                                the person who may not approve or send it.
--   purchase_order.limit_*       #21: the second person's approval a PO with
--                                no request needs above the PO limit.
--   purchasing_setting           #21: the PO limit (key `po_limit`, value
--                                {"amount": 5000}). No row = the default in
--                                shared PO_LIMIT_DEFAULT, so this migration
--                                inserts nothing and the seed has nothing to
--                                keep in step. No FK: the seed's TRUNCATE …
--                                CASCADE never reaches it.
--   invoice (task_id) unique     #26: one live (not void) invoice per work
--                                order — the database backstop of the check
--                                createInvoice makes under the task lock.
--   vendor_bill number unique    #20: a vendor's bill number once per vendor
--                                (not counting void bills).
--   purchase_order (request_id)  #21: one live (not cancelled) order per
--                                purchase request.
--
-- The three unique indexes are created only when the rows already on file
-- satisfy them (a DO block per index, RAISE NOTICE otherwise), so a database
-- carrying an old duplicate still migrates; the services enforce the same
-- rule under a row lock either way, and the duplicate is for a person to
-- void, not for a migration to guess at.

ALTER TABLE quote ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES principal(id) ON DELETE SET NULL;
ALTER TABLE quote ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

ALTER TABLE purchase_order ADD COLUMN IF NOT EXISTS limit_approved_by uuid REFERENCES principal(id) ON DELETE SET NULL;
ALTER TABLE purchase_order ADD COLUMN IF NOT EXISTS limit_approved_at timestamptz;

CREATE TABLE IF NOT EXISTS purchasing_setting (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM invoice WHERE status <> 'void' GROUP BY task_id HAVING count(*) > 1) THEN
    RAISE NOTICE '0083: a work order holds more than one live invoice; invoice_one_live_per_task not created';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS invoice_one_live_per_task ON invoice (task_id) WHERE status <> 'void';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM vendor_bill
     WHERE bill_number IS NOT NULL AND btrim(bill_number) <> '' AND status <> 'void'
     GROUP BY COALESCE(vendor_id::text, lower(btrim(vendor_name))), lower(btrim(bill_number))
    HAVING count(*) > 1
  ) THEN
    RAISE NOTICE '0083: a vendor bill number repeats for one vendor; vendor_bill_number_per_vendor not created';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS vendor_bill_number_per_vendor
      ON vendor_bill (COALESCE(vendor_id::text, lower(btrim(vendor_name))), lower(btrim(bill_number)))
      WHERE bill_number IS NOT NULL AND btrim(bill_number) <> '' AND status <> 'void';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM purchase_order
     WHERE request_id IS NOT NULL AND status <> 'cancelled'
     GROUP BY request_id HAVING count(*) > 1
  ) THEN
    RAISE NOTICE '0083: a purchase request has more than one live order; purchase_order_one_live_per_request not created';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_one_live_per_request
      ON purchase_order (request_id) WHERE request_id IS NOT NULL AND status <> 'cancelled';
  END IF;
END $$;
