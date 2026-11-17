-- 0156 · The sign-off sheet is a form (Elise, 2026-11-17).
--
-- The link texted to the technician opens OBI's own sign-off form
-- (/signoff/<token>): the manager on site types their name (and, on an EMCOR
-- sheet, the closeout number), signs with a finger, and presses Submit. The
-- API draws the signed PDF in the entity's design and files it on the work
-- order (Drive, a sign-off file, approved as it lands) and, when the
-- SharePoint integration copies files, in the work order's folder.
--
-- What the form recorded stays on the sheet's row. `signed_name` is also the
-- claim: a sheet is signed on the form once (the UPDATE that sets it asks it
-- to be NULL), and a new sheet (new token) is how a second signature is had.
-- A copy texted back as a photo (0070) still sets signed_at /
-- signed_attachment_id alone.

ALTER TABLE wo_signoff
  ADD COLUMN signed_name text,
  ADD COLUMN signed_closeout text,
  ADD COLUMN signed_via text CHECK (signed_via IN ('form', 'text'));
