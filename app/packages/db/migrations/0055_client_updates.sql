-- 0055 · Client updates — one tracker per client, shared by link or email.
--
-- Replaces the per-client tracking spreadsheets (e.g. "SUN Holdings
-- Tracking": WO # · Dispatcher · WO Mgr · Trade · Asset · Store · Location ·
-- Rec On · Comp On · Status · NTE · Client Notes). A tracker is a saved
-- question over the work orders; it stores no copy of any row, so every cell
-- the client sees is read from the work order at the moment it is shown or
-- sent. The page is /client-updates (services/clientUpdates.ts).
--
--   client_update            the tracker: the client (task.client), the
--                            filter set (same shape as a saved view), the
--                            ordered columns — each with its own label and a
--                            `shared` flag (false = our team sees it, the
--                            client never does) — the charts, the field our
--                            team types the client's note into, and how it is
--                            shared:
--                              share_*   a read-only public link
--                                        (/share/client-updates/<token>),
--                                        off until someone turns it on,
--                                        revocable, optionally expiring;
--                              email     subject, intro, to / cc, attach the
--                                        CSV, include the link;
--                              schedule  when the email goes out by itself
--                                        (next_run_at, America/Chicago), run
--                                        by the Vercel cron.
--   client_update_delivery   one row per email sent (or refused by the
--                            provider): who to, what subject, how many rows,
--                            which columns, sent / failed with the error.
--
-- Mail goes out from contact@seamlessfm.com (MAIL_FROM) through Microsoft
-- Graph or Resend (MAIL_PROVIDER); with neither configured the Send button
-- says so and nothing leaves. Every change is an admin audit row (entity
-- client_update); each work order in a sent update gets a
-- `client_update_sent` activity row, which also counts as the chase that
-- silences the approval follow-up clock.
--
-- Permission: client_updates (view / create / edit / delete) and
-- client_updates/share (edit = send, schedule, turn the link on). Admin, TL,
-- ATL and AM get both; the OM tiers and Ops Coordinator can open trackers.
-- Only where the path is not already set, so a Roles-screen decision survives.

CREATE TABLE IF NOT EXISTS client_update (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  client            text,
  description       text,
  filters           jsonb NOT NULL DEFAULT '{"match":"all","rules":[]}'::jsonb,
  columns           jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort              jsonb,
  group_by          text,
  charts            jsonb NOT NULL DEFAULT '[]'::jsonb,
  note_field        text,
  share_enabled     boolean NOT NULL DEFAULT false,
  share_token       text UNIQUE,
  share_expires_at  timestamptz,
  share_charts      boolean NOT NULL DEFAULT true,
  share_summary     boolean NOT NULL DEFAULT true,
  -- The site address the link was turned on from (https://…), so an email the
  -- cron sends at 8am carries the same link a person would have copied.
  share_origin      text,
  email             jsonb NOT NULL DEFAULT '{}'::jsonb,
  schedule          jsonb,
  next_run_at       timestamptz,
  last_sent_at      timestamptz,
  created_by        uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_update_client_idx ON client_update(client);
CREATE INDEX IF NOT EXISTS client_update_due_idx ON client_update(next_run_at) WHERE next_run_at IS NOT NULL;

DROP TRIGGER IF EXISTS client_update_touch ON client_update;
CREATE TRIGGER client_update_touch BEFORE UPDATE ON client_update
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS client_update_delivery (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_update_id     uuid NOT NULL REFERENCES client_update(id) ON DELETE CASCADE,
  trigger              text NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'test')),
  to_addresses         text[] NOT NULL DEFAULT '{}',
  cc_addresses         text[] NOT NULL DEFAULT '{}',
  subject              text NOT NULL,
  status               text NOT NULL CHECK (status IN ('sent', 'failed')),
  error                text,
  row_count            int NOT NULL DEFAULT 0,
  columns              text[] NOT NULL DEFAULT '{}',
  provider             text,
  provider_message_id  text,
  sent_by              uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_update_delivery_idx ON client_update_delivery(client_update_id, created_at DESC);

UPDATE role
   SET permissions = permissions
     || jsonb_build_object('client_updates', jsonb_build_object(
          'view', true, 'create', true, 'edit', true, 'delete', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am')
   AND NOT (permissions ? 'client_updates');

UPDATE role
   SET permissions = permissions
     || jsonb_build_object('client_updates/share', jsonb_build_object('edit', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am')
   AND NOT (permissions ? 'client_updates/share');

UPDATE role
   SET permissions = permissions
     || jsonb_build_object('client_updates', jsonb_build_object('view', true))
 WHERE code IN ('om', 'senior_om', 'om_probation', 'ops_coord')
   AND NOT (permissions ? 'client_updates');
