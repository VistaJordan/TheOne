-- 0052 · Messages on every work order — internal, or to the client.
--
-- The Messages tab becomes the conversation on a work order: a message is
-- either internal (the team only) or client-visible, and a client-visible one
-- is what the client CMMS integrations (Corrigo, ServiceChannel, and Ecotrak
-- once write-back is allowed) will carry across. Nothing here talks to any of
-- them yet; the shape is the contract they plug into.
--
-- The store is the existing `comment` table (the client-visibility boundary
-- since 0001): the Updates feed keeps reading it, the obligations engine keeps
-- counting a client-visible one as a chase, and every decision that posts an
-- internal note keeps landing in the same thread. Three things are new:
--
--   comment.source            'staff' (ours, author_principal_id set) or
--                             'client' (came in from their CMMS: no principal,
--                             external_author names who wrote it, external_id
--                             is their id so a re-sync never duplicates it)
--   comment.edited_at         an edit is allowed only while the message has
--                             not been sent anywhere; the audit trail carries
--                             the before/after body (message_edited)
--   comment_delivery          one row per (message, client system) — the
--                             outbox. pending until an adapter sends it, then
--                             sent (external_id = their note id) or failed
--                             (error, attempts). A message with any `sent`
--                             row is locked against edits.
--
-- Permission: work_orders/comments/client (create) is whether a role may post
-- a client-visible message at all; unset inherits work_orders/comments. The
-- two probation-grade tiers start without it; every other role inherits.

ALTER TABLE comment ALTER COLUMN author_principal_id DROP NOT NULL;
ALTER TABLE comment ADD COLUMN source          text NOT NULL DEFAULT 'staff'
                                                CHECK (source IN ('staff', 'client'));
ALTER TABLE comment ADD COLUMN external_author text;
ALTER TABLE comment ADD COLUMN external_target text
                                                CHECK (external_target IS NULL OR external_target IN ('ecotrak', 'corrigo', 'servicechannel'));
ALTER TABLE comment ADD COLUMN external_id     text;
ALTER TABLE comment ADD COLUMN edited_at       timestamptz;
ALTER TABLE comment ADD CONSTRAINT comment_author_or_client
  CHECK (source = 'client' OR author_principal_id IS NOT NULL);
-- A client's note is identified by (which system, their id); one row each.
CREATE UNIQUE INDEX comment_external_idx
  ON comment(external_target, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE comment_delivery (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id  uuid NOT NULL REFERENCES comment(id) ON DELETE CASCADE,
  target      text NOT NULL CHECK (target IN ('ecotrak', 'corrigo', 'servicechannel')),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  external_id text,
  error       text,
  attempts    int  NOT NULL DEFAULT 0,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comment_id, target)
);
CREATE INDEX comment_delivery_pending_idx ON comment_delivery(target, created_at) WHERE status = 'pending';
CREATE TRIGGER comment_delivery_touch BEFORE UPDATE ON comment_delivery
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Who may message the client. Only fills a path the role has not set, so a
-- Roles-screen decision survives a re-run.
UPDATE role
   SET permissions = permissions
     || jsonb_build_object('work_orders/comments/client', jsonb_build_object('create', false))
 WHERE code IN ('om_probation', 'ops_coord')
   AND NOT (permissions ? 'work_orders/comments/client');
