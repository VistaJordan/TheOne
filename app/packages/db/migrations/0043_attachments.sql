-- 0043 · Attachments that actually hold a file.
--
-- The table has existed since 0001 as a stub ("local disk in v0"), and the
-- three upload buttons in the app have been disabled ever since, because a
-- local disk does not exist on a serverless host: the filesystem is wiped
-- between requests. Files now live in a Vercel Blob store and this table
-- holds the metadata, with `storage_key` as the blob's pathname.
--
-- The store is PRIVATE. Nothing is served from a public blob URL — every read
-- goes back through the API, which checks the work order's scope first, so a
-- photo is exactly as visible as the work order it belongs to. That is also
-- why no URL is stored: a URL would outlive the permission check.
--
-- Two columns are added:
--   uploaded_by  who put it there, for the card and the audit trail.
--   visit_id     which visit it belongs to (0021), so the Photos card can
--                group before/after by the assessment and the job visit
--                instead of guessing from `client_visible`.

ALTER TABLE attachment
  ADD COLUMN IF NOT EXISTS uploaded_by uuid REFERENCES principal(id) ON DELETE SET NULL;

ALTER TABLE attachment
  ADD COLUMN IF NOT EXISTS visit_id uuid REFERENCES wo_visit(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS attachment_visit_idx ON attachment(visit_id);

-- Rows written before this migration have no file behind them (there was
-- nowhere to put one), so nothing needs backfilling: storage_key stays NULL
-- and the reader treats a row without one as metadata only.
COMMENT ON COLUMN attachment.storage_key IS
  'Vercel Blob pathname (private store). NULL = a pre-0043 row with no file behind it.';
