-- 0114 · Ecotrak webhooks and notes (Elise, 2026-11-02).
--
-- Ecotrak calls The One when a work order changes (WEBHOOK_WORKORDER_ACTIVITY)
-- or gets a comment (WEBHOOK_WORKORDER_COMMENT). The call is only a signal:
-- the receiver reads the work order and its notes back from Ecotrak with
-- read-only GETs, so nothing depends on the delivery's shape.
--
-- Registering the two webhooks on Ecotrak is the ONE write this integration
-- makes, and only to our own integration settings there (never a work order,
-- a note or anything a client sees). It is a button a super admin presses
-- once (services/ecotrakWebhooks.ts); it never edits or deletes a webhook.
--
-- No FK to principal: the seed truncates principal and these rows must
-- survive a re-seed.

-- One row per webhook this app registered on Ecotrak. The delivery URL
-- carries a random key; only its sha256 is kept here.
CREATE TABLE ecotrak_webhook (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action             text NOT NULL UNIQUE
                       CHECK (action IN ('WEBHOOK_WORKORDER_ACTIVITY', 'WEBHOOK_WORKORDER_COMMENT')),
  ecotrak_webhook_id text,
  url                text NOT NULL,           -- without the key
  secret_hash        text NOT NULL,
  registered_by      uuid,
  registered_at      timestamptz NOT NULL DEFAULT now()
);

-- Every delivery, kept verbatim: Ecotrak does not document the payload, so
-- this is how we learn it. Bounded by the receiver (it prunes past 30 days).
CREATE TABLE ecotrak_webhook_delivery (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  external_id  text,                          -- the Ecotrak work order it named, when found
  payload      jsonb NOT NULL,
  outcome      text NOT NULL,                 -- refreshed | synced | switched_off | not_found | failed
  error        text
);
CREATE INDEX ecotrak_webhook_delivery_received_idx ON ecotrak_webhook_delivery(received_at DESC);

-- When this work order's notes were last read from Ecotrak (NULL = never:
-- the sync reads those a few at a time, so existing work orders get their
-- comments too).
ALTER TABLE cmms_wo_link ADD COLUMN notes_synced_at timestamptz;
