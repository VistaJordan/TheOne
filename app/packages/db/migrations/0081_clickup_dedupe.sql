-- 0081 · ClickUp: look for the work order before creating it.
--
-- While the old Ecotrak → ClickUp integration still runs, a work order can
-- already be in ClickUp when The One receives it (Elise, 2026-10-13). Before
-- creating a task the sync looks for one created in the last `dedupe_days`
-- (30; 0 = off) whose NAME or "Ecotrak ID" field is our Client WO # (or our
-- Ecotrak ID). Found → the work order is linked to that task (and The One's
-- values are pushed onto it); not found → created as before.
--
-- No search per work order: `clickup_recent_task` is a small copy of the
-- workspace's tasks created in that window, topped up from ClickUp at most
-- once a run (`recent_synced_ms`), so the check is a local lookup.

ALTER TABLE clickup_config
  ADD COLUMN team_id          text,
  ADD COLUMN space_id         text,
  ADD COLUMN dedupe_days      int NOT NULL DEFAULT 30,
  ADD COLUMN recent_synced_ms bigint;

ALTER TABLE clickup_link
  ADD COLUMN matched_existing boolean NOT NULL DEFAULT false;

CREATE TABLE clickup_recent_task (
  cu_task_id  text PRIMARY KEY,
  name_key    text,
  ecotrak_key text,
  url         text,
  created_ms  bigint NOT NULL
);
CREATE INDEX clickup_recent_task_name_idx ON clickup_recent_task(name_key);
CREATE INDEX clickup_recent_task_ecotrak_idx ON clickup_recent_task(ecotrak_key);
