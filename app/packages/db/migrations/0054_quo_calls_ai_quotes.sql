-- 0054 · Calls placed from a work order through Quo, and the AI quote drafted
--        from a call's transcript.
--
-- Quo's API cannot START a call — only its app can. So the Call button on a
-- work order records the intent first (one wo_call row: who, which number,
-- "just call" or "call and draft a quote") and then hands the number to the
-- Quo app through a tel: link. When the call ends, Quo's webhooks
-- (POST /api/webhooks/quo) find that row again:
--
--   call.completed             matched to the newest `dialing` row for the
--                              number Quo dialled, placed in the 30 minutes
--                              before the call started; stamps quo_call_id,
--                              direction, answered / completed, duration
--   call.transcript.completed  the whole dialogue, by quo_call_id
--   call.summary.completed     Quo's own bullet summary + next steps
--
-- A call nobody placed from a work order is NOT stored: the webhook sees every
-- call on the monitored Quo lines and only the ones we dialled belong here.
-- When the webhook is not set up yet (or the call went out from a phone), the
-- transcript can be pasted onto the row by hand (transcript_source 'pasted').
--
-- quote_ai_draft is what Claude wrote from that transcript: the same shape
-- the quote builder saves (PUT /work-orders/:id/quote), kept apart from the
-- real quote until someone reviews it and presses Submit quote. Submitting
-- goes through the ordinary createQuote / updateQuote path, so the quote,
-- its number and its quote_updated audit row are exactly what typing it in
-- by hand would have produced. One draft per call; regenerating overwrites.
--
-- Permission: work_orders/calls — view = the call log and transcripts on a
-- work order; create = place a call (and paste a transcript). Every role
-- starts with both; drafting and submitting a quote still need the quotes
-- grants (create / edit), exactly like the builder.

CREATE TABLE wo_call (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  placed_by         uuid NOT NULL REFERENCES principal(id),
  contact_name      text,
  contact_role      text NOT NULL DEFAULT 'other'
                      CHECK (contact_role IN ('tech', 'vendor', 'client', 'other')),
  phone             text NOT NULL,              -- E.164, '+14095550143'
  purpose           text NOT NULL DEFAULT 'call' CHECK (purpose IN ('call', 'quote')),
  status            text NOT NULL DEFAULT 'dialing'
                      CHECK (status IN ('dialing', 'completed', 'missed', 'transcribed')),
  quo_call_id       text UNIQUE,                -- Quo's 'AC…' id once matched
  quo_user_id       text,
  direction         text CHECK (direction IS NULL OR direction IN ('incoming', 'outgoing')),
  answered_at       timestamptz,
  completed_at      timestamptz,
  duration_seconds  int,
  transcript        jsonb,                      -- [{speaker, line, start}] or NULL
  transcript_source text CHECK (transcript_source IS NULL OR transcript_source IN ('quo', 'pasted')),
  summary           jsonb,                      -- {summary: [], next_steps: []} or NULL
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wo_call_task_idx ON wo_call(task_id, created_at DESC);
-- The webhook's match: an unmatched row for this number, newest first.
CREATE INDEX wo_call_dialing_idx ON wo_call(phone, created_at DESC) WHERE quo_call_id IS NULL;
CREATE TRIGGER wo_call_touch BEFORE UPDATE ON wo_call
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE quote_ai_draft (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  call_id       uuid NOT NULL UNIQUE REFERENCES wo_call(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'ready'
                  CHECK (status IN ('ready', 'submitted', 'discarded')),
  draft         jsonb NOT NULL,                 -- the quote builder's PUT body
  assumptions   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ["Used the contract's $95/h …", …]
  missing_info  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ["No price was given for …", …]
  model         text,
  usage         jsonb,                          -- the API's token counts, for cost tracking
  created_by    uuid NOT NULL REFERENCES principal(id),
  submitted_by  uuid REFERENCES principal(id),
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quote_ai_draft_task_idx ON quote_ai_draft(task_id);
CREATE TRIGGER quote_ai_draft_touch BEFORE UPDATE ON quote_ai_draft
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Everyone may call and read calls. Only fills a path the role has not set,
-- so a Roles-screen decision survives a re-run.
UPDATE role
   SET permissions = permissions
     || jsonb_build_object('work_orders/calls', jsonb_build_object('view', true, 'create', true))
 WHERE NOT (permissions ? 'work_orders/calls');
