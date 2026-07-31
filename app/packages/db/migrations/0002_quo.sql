-- ============================================================================
-- 0002_quo.sql — Sprint 3: the Quo (OpenPhone) conversation mirror.
--
-- Messages = a MIRROR of the dispatcher <-> technician Quo conversation,
-- correlated to a work order through the tech VENDOR's phone line
-- (product/quotes-payments.md §5). It is the EXTERNAL tech channel and is
-- NEVER client-visible — hence no `client_visible` column anywhere below:
-- absence of the flag is the commitment, exactly as `comment.client_visible`
-- is the commitment on the client-facing side.
--
-- The real pipe (Quotato) writes these rows later; S3 seeds a demo thread and
-- adds one local-send path (POST → quo_message pending_sync=true).
-- Postgres-16 compatible; the runner passes this file WHOLE to db.exec().
-- ============================================================================

-- ── CONVERSATION — one tech line per job thread ─────────────────────────────
-- vendor_id is the correlation seam: a WO reaches its conversation through the
-- vendor it is linked to (payable.vendor_id in the prototype).
CREATE TABLE quo_conversation (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id          uuid NOT NULL REFERENCES vendor(id),
  counterparty_phone text,                 -- the technician's number, as dialed
  quo_line_label     text,                 -- monitored Quo line, e.g. 'Dispatch TX-01'
  claimed_by         text,                 -- dispatcher who claimed the line (free text in v0)
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quo_conversation_vendor_idx ON quo_conversation(vendor_id);

-- ── CALL — direction, duration, AI summary, full transcript ─────────────────
-- transcript is a JSONB ARRAY of {speaker, line}. Stored whole (not row-per-line)
-- because it arrives whole from the Quo webhook and is only ever read whole;
-- the UI shows the first two entries and derives "N more lines" from the length.
CREATE TABLE quo_call (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES quo_conversation(id) ON DELETE CASCADE,
  direction        text NOT NULL CHECK (direction IN ('in','out')),
  duration_seconds int,
  ai_summary       text,
  transcript       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{speaker,line}, …]
  occurred_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quo_call_conversation_idx ON quo_call(conversation_id, occurred_at);

-- ── MESSAGE — SMS / MMS ─────────────────────────────────────────────────────
-- media is a JSONB ARRAY of {name, label}; [] means a plain text (SMS).
-- delivered / pending_sync are the two independent bits of send state:
--   inbound + seeded outbound : delivered=true,  pending_sync=false
--   locally composed (S3 POST): delivered=false, pending_sync=true  ← not on the
--     wire yet; the real Quo pipe flips both when it takes over.
CREATE TABLE quo_message (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES quo_conversation(id) ON DELETE CASCADE,
  direction       text NOT NULL CHECK (direction IN ('in','out')),
  body            text,
  media           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{name,label}, …]
  delivered       boolean NOT NULL DEFAULT true,
  pending_sync    boolean NOT NULL DEFAULT false,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quo_message_conversation_idx ON quo_message(conversation_id, occurred_at);

-- ── JOB SEGMENT — the visit boundary Quotato derives from time windows ──────
CREATE TABLE quo_job_segment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES quo_conversation(id) ON DELETE CASCADE,
  label           text NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quo_job_segment_conversation_idx ON quo_job_segment(conversation_id, started_at);
