-- 0146 · Specs and the note to the customer belong to a section (Elise, 2026-11-16).
--
-- Until now a quote had ONE "Equipment & part specs" box and ONE "Note to
-- customer", under all the sections. Each section now carries its own: the
-- Incurred section and every option of every round. Specs stay internal
-- (never printed or sent); a section's note prints under that section in the
-- summary and on the printed quote.
--
-- The quote's own two columns stay (an AI draft or an older client may still
-- send them) but are moved onto the quote's Incurred section here and cleared
-- where they were moved, so nothing prints twice. A quote with no live
-- Incurred section keeps its values, and the summary still prints such a
-- note at the foot as before.

ALTER TABLE quote_section ADD COLUMN IF NOT EXISTS specs text;
ALTER TABLE quote_section ADD COLUMN IF NOT EXISTS note_to_customer text;

WITH moved AS (
  UPDATE quote_section s
     SET specs = COALESCE(s.specs, q.specs),
         note_to_customer = COALESCE(s.note_to_customer, q.note_to_customer)
    FROM quote q
   WHERE s.quote_id = q.id
     AND s.kind = 'incurred'
     AND s.deleted_at IS NULL
     AND (q.specs IS NOT NULL OR q.note_to_customer IS NOT NULL)
  RETURNING s.quote_id
)
UPDATE quote
   SET specs = NULL, note_to_customer = NULL
 WHERE id IN (SELECT quote_id FROM moved);
