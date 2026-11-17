-- 0155 · On call and After hours in the header (Elise, 2026-11-17).
--
-- A Google Sheet says which AM, TL, ATL or OP Admin is on call on which day.
-- OBI reads it (services/onCall.ts) into on_call_shift, one row per (day,
-- person). While a shift runs (start_hour to end_hour, America/Chicago, on the
-- shift's day; 12 AM to 3 PM by default) the person gets the After hours
-- button in the header and sees every work order they may open — lists,
-- approvals and notifications — not only their own jobs.
--
-- No FK to principal: the seed truncates principal … CASCADE and neither
-- table is truncated by it, so the roster and the settings survive a re-seed.

CREATE TABLE IF NOT EXISTS on_call_setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS on_call_shift (
  day          date NOT NULL,
  principal_id uuid NOT NULL,
  name         text NOT NULL,
  sheet_row    integer,
  synced_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, principal_id)
);

CREATE INDEX IF NOT EXISTS on_call_shift_principal_idx ON on_call_shift (principal_id, day);
