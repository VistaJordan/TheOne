-- 0144 · Notifications follow the people on the job (Elise, 2026-11-16).
--
-- A notice about a work order shows only to the people assigned to it (the
-- Assignee, Support Trainee, TL, ATL, AM and Completion Assignee seats); the
-- After hours switch on the page shows the rest. To ask "who is on this job"
-- the inbox needs the work order a notice is about: `task_id`, filled by
-- notify() from the notice's link (`/work-orders/<WO #>…`).
--
-- No FK on purpose: the seed TRUNCATEs task … CASCADE, which would empty
-- every inbox; a stale id simply matches no work order and the notice shows
-- as one about nothing in particular.

ALTER TABLE app_notice ADD COLUMN IF NOT EXISTS task_id uuid;

UPDATE app_notice n
   SET task_id = t.id
  FROM task t
 WHERE n.task_id IS NULL
   AND n.link LIKE '/work-orders/%'
   AND t.wo_number = split_part(split_part(split_part(substr(n.link, 14), '?', 1), '#', 1), '/', 1);

CREATE INDEX IF NOT EXISTS app_notice_task_idx ON app_notice (task_id) WHERE task_id IS NOT NULL;
