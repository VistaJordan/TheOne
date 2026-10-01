-- 0059 · In-app notices (`app_notice`). The Pulse already owns the table
-- `notification` (0004: one row per obligation ping) and the /notifications
-- routes; this is the other half of the bell — things that happened to you
-- that are not a work-order clock — so it has its own table and its own name.
--
-- One row per (person, thing they should know). Nothing here sends an email:
-- the row is read from the bell in the top bar and that is all. The Vendors
-- section is the first writer (a task given to you, a review to decide, a
-- vendor handed to you, a decision on something you raised, an insurance date
-- running out on a vendor you own), but the table is generic — `kind` names
-- the writer's reason and `link` is where the bell takes you.
--
-- `dedupe_key` makes a notice that is derived from state (an expiry entering
-- its 30-day band) safe to raise again and again: the second insert is a
-- no-op. Notices raised by an act (a task assigned) leave it NULL.
--
-- The FK cascades, so the seed's TRUNCATE principal … CASCADE clears it; a
-- notification is data about people, not configuration.

CREATE TABLE app_notice (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  title        text NOT NULL,
  body         text,
  link         text,
  actor_id     uuid REFERENCES principal(id) ON DELETE SET NULL,
  dedupe_key   text,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX app_notice_inbox_idx ON app_notice (principal_id, created_at DESC);
CREATE INDEX app_notice_unread_idx ON app_notice (principal_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX app_notice_dedupe_idx ON app_notice (principal_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
