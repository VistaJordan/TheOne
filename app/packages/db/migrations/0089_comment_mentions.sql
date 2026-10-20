-- @mentions in work-order messages (services/woMessages.ts,
-- packages/shared/src/mentions.ts).
--
-- One row per (message, person it mentions). The body itself stays plain
-- text ("@Display Name") because a client-visible message goes to the
-- client's CMMS as written; this table is what says WHO an "@Name" is. The
-- API writes it in the same transaction as the message and keeps only the
-- people whose "@Name" is still in the body, so an edit that deletes the
-- name drops the row. The person hears about it through an app_notice
-- (kind 'wo_mention', 0059's bell); there is no read state here.
--
-- Both foreign keys cascade: the seed TRUNCATEs comment and principal
-- CASCADE, and a message deleted with its work order takes its mentions with
-- it. No data: nothing for seed.ts to keep in step.

CREATE TABLE IF NOT EXISTS comment_mention (
  comment_id   uuid NOT NULL REFERENCES comment(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, principal_id)
);

-- "Messages that mention me" reads by person.
CREATE INDEX IF NOT EXISTS comment_mention_principal_idx
  ON comment_mention (principal_id, created_at DESC);
