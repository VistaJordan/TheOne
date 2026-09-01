-- 0013 · Delayed automations — the pending-timer queue.
--
-- A rule whose trigger carries `delay_minutes` does not act when it matches;
-- it upserts a row here and the API's scheduler (services/automations.ts,
-- started in index.ts) fires it once due_at passes, re-evaluating the rule's
-- conditions AT THAT MOMENT — "when CICO is updated and 10 minutes pass, if
-- the quote is STILL not ready, then …". Another matching change before the
-- timer fires re-arms it (the UNIQUE pair makes that an upsert).
--
-- Timers being rows, not setTimeouts, is the point: they survive API restarts
-- and re-seeds (task_id is a bare uuid for the same no-FK reason as 0012 —
-- seed.ts TRUNCATEs task with CASCADE; a dangling task simply never fires and
-- the row is swept when it comes due).

CREATE TABLE IF NOT EXISTS automation_pending (
  id            bigserial PRIMARY KEY,
  automation_id uuid NOT NULL REFERENCES automation(id) ON DELETE CASCADE,
  task_id       uuid NOT NULL,
  due_at        timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_id, task_id)
);

CREATE INDEX IF NOT EXISTS automation_pending_due ON automation_pending (due_at ASC);
