-- 0077 · Import a transcript to draft a quote.
--
-- 0054 drafts a quote from the transcript of a call placed from the work
-- order through Quo. A conversation that happened anywhere else — a Teams or
-- Zoom meeting, a site walk recorded on a phone, a call from a personal
-- line — can now be imported from the quote itself (Import transcript on the
-- quote builder and the Client quote card): a text, .vtt or .srt file, or the
-- text pasted in. It becomes a wo_call row with no number behind it
-- (phone NULL, transcript_source 'imported', purpose 'quote', status
-- 'transcribed'), so the AI draft page, its review, Submit quote and the
-- audit trail are exactly the call path's. The Quo webhook only ever matches
-- rows by number, so a row without one is never mistaken for a call.

ALTER TABLE wo_call ALTER COLUMN phone DROP NOT NULL;

ALTER TABLE wo_call DROP CONSTRAINT IF EXISTS wo_call_transcript_source_check;
ALTER TABLE wo_call ADD CONSTRAINT wo_call_transcript_source_check
  CHECK (transcript_source IS NULL OR transcript_source IN ('quo', 'pasted', 'imported'));

-- A row with no number must be an imported transcript.
ALTER TABLE wo_call ADD CONSTRAINT wo_call_phone_or_imported
  CHECK (phone IS NOT NULL OR transcript_source = 'imported');
