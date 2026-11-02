-- 0116 · The sign-off sheet as a link too (Elise, 2026-11-02).
--
-- Before The One, the team texted technicians a Paperform link per billing
-- entity, with the work order number and the address already filled in
-- (https://bkremcor.paperform.co/?ed9ra=<WO #>&bf7ou=<address>). Send to tech
-- now offers that link or the PDF. A link share needs no drawn sheet (the
-- form lives on Paperform and is signed there), so `signoff_id` may be NULL
-- and `kind` says which of the two went out. The links themselves are built
-- in code (SIGNOFF_FORM_URLS in packages/shared/src/signoff.ts); nothing is
-- stored per work order.

ALTER TABLE wo_signoff_share ALTER COLUMN signoff_id DROP NOT NULL;
ALTER TABLE wo_signoff_share ADD COLUMN kind text NOT NULL DEFAULT 'pdf';
ALTER TABLE wo_signoff_share ADD CONSTRAINT wo_signoff_share_kind_check CHECK (kind IN ('pdf', 'link'));
-- A PDF share names its sheet; a link share may not have one.
ALTER TABLE wo_signoff_share ADD CONSTRAINT wo_signoff_share_pdf_has_sheet CHECK (kind = 'link' OR signoff_id IS NOT NULL);
