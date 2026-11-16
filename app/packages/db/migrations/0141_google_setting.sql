-- 0141 · The Google Maps daily limit, set from the admin page (Elise, 2026-11-15).
--
-- 0140 read the daily limit on suggestion requests from the server's
-- environment (GOOGLE_PLACES_DAILY_CAP), which takes Vercel access and a
-- redeploy to change. It is now a number typed under the Google Maps row in
-- Admin › Integrations: the row 'daily_cap' here, {"value": <n>} (0 = no
-- limit). No row = the environment's number, else 3,000, as before.
--
-- Configuration: no FK (updated_by is a plain uuid), the seed does not
-- truncate it.

CREATE TABLE IF NOT EXISTS google_setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
