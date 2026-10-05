-- 0068 · The assistant: ask a question about anything in The One and get an
-- answer looked up live, as the person asking.
--
-- Three tables. A conversation and its messages belong to one person and go
-- with them. A taught note is configuration (how Seamless uses a word, a rule
-- the assistant got wrong once): no FK to principal, so a re-seed leaves the
-- notes alone, the 0012 reasoning.
--
-- The assistant only reads. Every look-up it makes is one of the app's own
-- GET routes called with the asker's session, so nothing here grants sight of
-- a record: the permission below only decides who may open the panel.

CREATE TABLE assistant_conversation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  title        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_conversation_owner_idx ON assistant_conversation (principal_id, updated_at DESC);

-- One row per question and one per answer. `lookups` is what the answer was
-- built from (tool, what was asked of it, how it went) and is what a reviewer
-- reads when an answer was wrong. `feedback` is the asker's thumb: 1 or -1.
CREATE TABLE assistant_message (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES assistant_conversation(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  body            text NOT NULL,
  status          text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'cut_short', 'declined', 'error')),
  lookups         jsonb NOT NULL DEFAULT '[]'::jsonb,
  model           text,
  usage           jsonb,
  feedback        smallint CHECK (feedback IN (1, -1)),
  feedback_note   text,
  feedback_at     timestamptz,
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_message_conversation_idx ON assistant_message (conversation_id, created_at);
CREATE INDEX assistant_message_feedback_idx ON assistant_message (feedback_at DESC) WHERE feedback IS NOT NULL;

-- What the assistant has been taught. Every active note is read before every
-- answer, so they are kept by the people trusted to speak for everyone.
CREATE TABLE assistant_note (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  body       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Who may do what ─────────────────────────────────────────────────────────
-- view = ask. edit = teach it (the notes) and review the answers people marked
-- wrong. Everyone asks; Admin teaches.

UPDATE role SET permissions = permissions
    || jsonb_build_object('assistant', jsonb_build_object('view', true, 'edit', true))
 WHERE code = 'admin' AND NOT (permissions ? 'assistant');

UPDATE role SET permissions = permissions
    || jsonb_build_object('assistant', jsonb_build_object('view', true, 'edit', false))
 WHERE code <> 'admin' AND NOT (permissions ? 'assistant');
