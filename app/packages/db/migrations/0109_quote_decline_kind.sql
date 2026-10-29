-- Elise, 2026-10-29: a client's decline is one of two kinds.
--   challenged — the client pushes back on the price: the work order goes back
--                to Waiting for Quote and a new round is opened (as before).
--   bfi        — bill for incurred only: the Incurred section stays, the
--                proposed options of the round are taken off the live quote
--                (kept, restorable), Bill For Incurred is ticked and the work
--                order moves to Done / Incurred.
-- quote_section.bfi_removed_at marks the options a BFI decline took off, so
-- "Restore removed options" can bring exactly those back. A full copy of the
-- quote before the removal is also in quote_revision_snapshot.
ALTER TABLE quote ADD COLUMN IF NOT EXISTS client_decline_kind text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_client_decline_kind_check') THEN
    ALTER TABLE quote ADD CONSTRAINT quote_client_decline_kind_check
      CHECK (client_decline_kind IS NULL OR client_decline_kind IN ('challenged', 'bfi'));
  END IF;
END $$;
ALTER TABLE quote_section ADD COLUMN IF NOT EXISTS bfi_removed_at timestamptz;
