-- 0079 · Ecotrak: two switches, both OFF until someone turns them on.
--
-- Admin › Integrations now shows Ecotrak twice:
--   ecotrak           "Ecotrak → The One"  — the read-only sync, every 10
--                     minutes from Vercel's cron, or Sync now in Admin.
--   ecotrak_outbound  "The One → Ecotrak"  — locked off in code: nothing
--                     that can write to Ecotrak exists yet.
-- Elise, 2026-10-13: nothing may contact Ecotrak unless it is switched on
-- there, and nothing may change what clients see on Ecotrak. 0074 seeded
-- 'ecotrak' ON; this turns it OFF, and both keys now default to off in code
-- when no row (or no readable table) answers.
--
-- The connection also learns about runs: a 5-minute lease so the cron and a
-- Sync now never overlap, and the last run's outcome for the Admin panel.
-- A link remembers the last payload it saw, so a work order nobody touched
-- on Ecotrak is left alone by the 10-minute poll (no write, no audit row).

INSERT INTO integration_setting (key, enabled) VALUES ('ecotrak', false)
ON CONFLICT (key) DO UPDATE SET enabled = false, updated_by = NULL, updated_at = now();

INSERT INTO integration_setting (key, enabled) VALUES ('ecotrak_outbound', false)
ON CONFLICT (key) DO UPDATE SET enabled = false, updated_by = NULL, updated_at = now();

ALTER TABLE cmms_connection
  ADD COLUMN IF NOT EXISTS run_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_run jsonb;

ALTER TABLE cmms_wo_link
  ADD COLUMN IF NOT EXISTS last_payload_hash text;
