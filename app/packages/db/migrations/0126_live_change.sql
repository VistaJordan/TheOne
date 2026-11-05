-- 0126 · Live sync between accounts (Elise, 2026-11-05: "I want all changes
-- to be synced between all accounts, so when we view the work order from
-- multiple accounts we all see the updates directly").
--
-- One row per successful write request (apps/api/src/plugins/liveChange.ts):
-- which browser tab made it (the x-obi-tab header; NULL for a webhook or a
-- cron), and when. Every open screen polls GET /activity/since for rows past
-- the one it last saw that another tab made, and re-reads what it shows. It
-- records THAT something changed, never what: no record, no field, no person.
--
-- UNLOGGED and pruned to the last hour: it is a doorbell, not history (the
-- audit trail is activity_log). No FK, so the seed's TRUNCATEs never touch it.

CREATE UNLOGGED TABLE IF NOT EXISTS live_change (
  id         bigserial   PRIMARY KEY,
  tab_id     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
