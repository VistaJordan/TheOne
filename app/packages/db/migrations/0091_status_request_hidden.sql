-- 0091 · Statuses a dispatcher may not even request (Elise, 2026-10-22).
--
-- The statuses ClickUp marks "!!" — Approved, Waiting for Advice, Waiting
-- for Approval, Ready to Invoice, Cancelled / Postponed — are a manager's
-- call. A person in request mode (work_orders/status create without edit:
-- the dispatcher tiers, VR Officer, OP Admin) is not offered them in the
-- status menu and a request for one is refused (409 STATUS_REQUEST_HIDDEN).
-- The flag is per status so Admin › Custom fields › Statuses ("Managers
-- only") can change the list without a deploy. The names here are
-- REQUEST_HIDDEN_STATUS_NAMES in packages/shared/src/workflow.ts and the
-- seed ticks the same ones — keep the three in step.

ALTER TABLE status
  ADD COLUMN IF NOT EXISTS request_hidden boolean NOT NULL DEFAULT false;

UPDATE status
   SET request_hidden = true
 WHERE lower(name) IN (
   'approved',
   'waiting for advice',
   'waiting for approval',
   'ready to invoice',
   'cancelled / postponed'
 );
