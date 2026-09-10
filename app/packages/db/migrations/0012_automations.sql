-- 0012 · Automations — the rules engine (When → If → Then).
--
-- `automation` holds the rules an admin builds on the Admin › Automations page:
--   trigger     {"kind":"created"} or {"kind":"changed","field":<catalogue key
--               or null for any>,"to":<value or null for any>}
--   conditions  the SAME FilterSet shape the list's filter builder saves —
--               compiled by woFields.ts against the one work order that fired
--   actions     [{"field":<catalogue key>,"value":<string or null to clear>}]
--
-- `automation_run` is the run log: one row per rule firing per work order.
--
-- DELIBERATELY NO FOREIGN KEYS to principal or task: seed.ts TRUNCATEs both
-- with CASCADE, and a cascade would silently wipe every rule an admin built.
-- Automations are configuration, not sample data — they must survive a re-seed
-- (the same decision status_group_def made in 0008). created_by / task_id are
-- therefore bare uuids that may dangle after a re-seed; the run log keeps
-- wo_number as text so old runs stay readable either way.

CREATE TABLE IF NOT EXISTS automation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  trigger     jsonb NOT NULL,
  conditions  jsonb NOT NULL DEFAULT '{"match":"all","rules":[]}'::jsonb,
  actions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  position    integer NOT NULL DEFAULT 0,
  run_count   integer NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_run (
  id            bigserial PRIMARY KEY,
  automation_id uuid NOT NULL REFERENCES automation(id) ON DELETE CASCADE,
  task_id       uuid,
  wo_number     text,
  outcome       text NOT NULL,
  detail        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automation_run_by_rule
  ON automation_run (automation_id, created_at DESC);
