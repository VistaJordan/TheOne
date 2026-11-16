-- 0152 · Projected Cost; the status order Open → Assessment Sched → On Site
-- (Assessment) → Job Sched → On Site (Job) (Elise, 2026-11-16, UAT #24 / #42).
--
-- 1. `Projected Cost` (currency, Finances section): the cost expected on the
--    job, typed by hand on the Finances card. Cost itself is now written only
--    by the payments (SYSTEM_MONEY_KEYS in shared moneyRules.ts) — no
--    migration for that, it is code. Not client-safe (a Finances figure, #17).
--    seed.ts carries the same row — KEEP IN STEP.
-- 2. The statuses' order (status.position — the status menu, the list's
--    status tabs and groups, Admin › Statuses all read it): the assessment's
--    visit follows its scheduling, then the job's. PM Sched goes after On
--    Site (Job); everything else keeps its place. Matched by name; a status an
--    admin renamed is left where it is. seed.ts applies the same positions.

INSERT INTO field_def (container_id, key, label, type, type_config, position, client_safe)
SELECT c.id, 'Projected Cost', 'Projected Cost', 'currency'::field_type, '{}'::jsonb,
       (SELECT COALESCE(max(position), 0) FROM field_def WHERE container_id = c.id) + 1,
       false
  FROM container c
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;

UPDATE status s
   SET position = v.pos
  FROM (VALUES
    ('Assessment Sched',     2),
    ('On Site (Assessment)', 3),
    ('Job Sched',            4),
    ('On Site (Job)',        5),
    ('PM Sched',             6)
  ) AS v(name, pos)
 WHERE s.name = v.name;
