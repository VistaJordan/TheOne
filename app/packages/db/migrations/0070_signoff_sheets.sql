-- 0070 · Sign-off sheets.
--
-- What the Make automation did for the old ClickUp board, inside The One: a
-- blank, branded sign-off sheet per work order (the billing entity's layout,
-- the client's work order number and the service address already filled),
-- shared with a technician by text through Quo, and the signed copy the
-- technician texts back filed on the work order as a sign-off attachment
-- (kind 'signoff', 0061) with the '24. Sign-Off Link' field pointing at it.
--
--   wo_signoff        one row per generated blank sheet; the newest un-
--                     superseded row is "the" sheet. `token` is the public
--                     download link's credential — a blank sheet with a WO
--                     number and an address on it, nothing more, so it is
--                     stored in clear so the link can be re-sent.
--   wo_signoff_share  every time a sheet went to a phone (Quo API or the
--                     Quo app). The inbound webhook matches a reply to its
--                     work order through these rows.
--   wo_signoff_reply  an inbound text with a file from a number that holds
--                     more than one open sheet — held until a person says
--                     which work order it belongs to. A reply that matches
--                     exactly one sheet never lands here; it is filed at once.

CREATE TABLE wo_signoff (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id              uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  layout               text NOT NULL,            -- sfm | tpm | af | rf | eds | bkr | bkr_emcor
  entity               text,                     -- '21. Comp' when generated
  wo_ref               text NOT NULL,            -- the number printed on the sheet
  address              text,                     -- the address printed on the sheet
  storage_key          text NOT NULL,            -- the blank PDF in the Blob store
  token                text NOT NULL UNIQUE,     -- 32 url-safe chars: /api/public/signoff/<token>
  created_by           uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  superseded_at        timestamptz,              -- a newer sheet replaced this one
  signed_attachment_id uuid REFERENCES attachment(id) ON DELETE SET NULL,
  signed_at            timestamptz
);
CREATE INDEX wo_signoff_task_idx ON wo_signoff(task_id, created_at DESC);

CREATE TABLE wo_signoff_share (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signoff_id      uuid NOT NULL REFERENCES wo_signoff(id) ON DELETE CASCADE,
  task_id         uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  vendor_id       uuid REFERENCES vendor(id) ON DELETE SET NULL,
  tech_name       text,
  phone           text NOT NULL,                 -- E.164
  channel         text NOT NULL CHECK (channel IN ('quo_api', 'quo_app')),
  quo_message_id  text,                          -- Quo's 'AC…' id when sent by API
  sent_by         uuid REFERENCES principal(id) ON DELETE SET NULL,
  sent_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wo_signoff_share_phone_idx ON wo_signoff_share(phone, sent_at DESC);
CREATE INDEX wo_signoff_share_task_idx  ON wo_signoff_share(task_id, sent_at DESC);

CREATE TABLE wo_signoff_reply (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quo_message_id     text UNIQUE,
  phone              text NOT NULL,
  tech_name          text,
  storage_key        text NOT NULL,              -- the file, already copied into the Blob store
  file_name          text NOT NULL,
  content_type       text NOT NULL,
  byte_size          int  NOT NULL,
  body               text,                       -- the text that came with it
  candidate_task_ids uuid[] NOT NULL DEFAULT '{}',
  received_at        timestamptz NOT NULL DEFAULT now(),
  attached_task_id   uuid REFERENCES task(id) ON DELETE SET NULL,
  attachment_id      uuid REFERENCES attachment(id) ON DELETE SET NULL,
  resolved_by        uuid REFERENCES principal(id) ON DELETE SET NULL,
  resolved_at        timestamptz,
  dismissed_at       timestamptz
);
CREATE INDEX wo_signoff_reply_open_idx ON wo_signoff_reply(received_at DESC)
  WHERE resolved_at IS NULL AND dismissed_at IS NULL;
