-- 0092 · A dispatcher's quote is corrected by a manager before it is
-- approved (Elise, 2026-10-22).
--
-- New quote status `pending_correction`, between draft and pending_approval:
--   draft → pending_correction      a dispatcher's "Submit for correction"
--   pending_correction → pending_approval   a manager's "Submit for approval",
--                                   after editing it in place (an edit there
--                                   does NOT return it to draft, unlike one in
--                                   pending_approval — 0083 #23)
--   pending_correction → draft      "Reject with note", as from pending_approval
-- A manager's own quote still goes draft → pending_approval. The rule is
-- quoteSubmitTarget in packages/shared/src/quoteSubmit.ts; the transitions
-- are in apps/api/src/services/quotes.ts. No rows change.

ALTER TABLE quote DROP CONSTRAINT IF EXISTS quote_status_check;
ALTER TABLE quote ADD CONSTRAINT quote_status_check
  CHECK (status IN ('draft','pending_correction','pending_approval','approved','sent','client_approved','client_declined'));
