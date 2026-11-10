-- 0131 · An integration starts from the moment it is turned on (Elise,
-- 2026-11-10). Nothing posted, approved or changed before that moment is sent
-- or replayed when a connector goes live.
--
--   integration_setting.on_since   when the switch last went from off to on
--                                  (NULL = never turned on by hand). Paths
--                                  that file a backlog (the SharePoint sweep)
--                                  start no earlier than it.
--   comment_delivery 'skipped'     a client-visible message posted while its
--                                  client system could not send (switched
--                                  off, or no connector yet). It is kept on
--                                  the work order and never sent later.
--
-- Every delivery still pending today was queued while no connector existed
-- (none is registered), so they all become skipped: turning Corrigo or
-- ServiceChannel on later will not send them.

ALTER TABLE integration_setting ADD COLUMN on_since timestamptz;
UPDATE integration_setting SET on_since = updated_at WHERE enabled AND on_since IS NULL;

ALTER TABLE comment_delivery DROP CONSTRAINT IF EXISTS comment_delivery_status_check;
ALTER TABLE comment_delivery
  ADD CONSTRAINT comment_delivery_status_check CHECK (status IN ('pending', 'sent', 'failed', 'skipped'));

UPDATE comment_delivery
   SET status = 'skipped',
       error  = 'Not sent: the client system was not live when this was posted'
 WHERE status = 'pending';
