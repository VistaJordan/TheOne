-- ============================================================================
-- 0004 · Authentication (Microsoft Entra ID) + super admins
--
-- Until now `principal.role` WAS the permission and the acting principal came
-- from an X-Actor-Id header the browser set freely (services/activity.ts). This
-- migration adds the columns that let a real session decide instead:
--
--   status        invited → active on first successful sign-in; disabled locks out
--   is_super_admin  the four named accounts below; gates the admin console
--   entra_oid     Entra's immutable object id, bound on first sign-in
--
-- Sign-in is INVITE-ONLY: the callback looks the principal up by verified email
-- and refuses anyone not already here (see services/auth.ts). Creating the row
-- IS the invitation — there is no self-registration path.
--
-- Following 0003's precedent, the data statements are carried here as well as in
-- the seed, so a pgdata that is migrated but never re-seeded lands in the same
-- state. Keep the two in step.
-- ============================================================================

ALTER TABLE principal
  ADD COLUMN IF NOT EXISTS status         text        NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS is_super_admin boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS entra_oid      text,
  ADD COLUMN IF NOT EXISTS last_login_at  timestamptz;

-- 'invited' = row exists, never signed in. 'active' = has signed in at least
-- once. 'disabled' = kept for activity_log attribution but cannot sign in.
ALTER TABLE principal
  DROP CONSTRAINT IF EXISTS principal_status_check;
ALTER TABLE principal
  ADD CONSTRAINT principal_status_check
  CHECK (status IN ('invited', 'active', 'disabled'));

-- One Entra identity maps to at most one principal. Partial so the 20-odd
-- seeded humans who have never signed in don't collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS principal_entra_oid_key
  ON principal (entra_oid) WHERE entra_oid IS NOT NULL;

-- Email is the join key between Entra and this table, so it has to be unique
-- and case-insensitive — 'Elise@…' and 'elise@…' are one person.
CREATE UNIQUE INDEX IF NOT EXISTS principal_email_lower_key
  ON principal (lower(email)) WHERE email IS NOT NULL;

-- ============ SESSIONS ============
-- Server-side sessions, not JWTs: signing out has to revoke immediately, and
-- disabling a user in the admin console has to end their session on the next
-- request rather than whenever a token happens to expire.
CREATE TABLE IF NOT EXISTS session (
  id             text PRIMARY KEY,                       -- 256-bit random, sent as an httpOnly cookie
  principal_id   uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  -- Set only while a super admin is impersonating someone. `principal_id` stays
  -- the REAL human, so every write is still attributed to who actually did it.
  impersonating_id uuid REFERENCES principal(id) ON DELETE SET NULL,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  user_agent     text,
  ip             text
);
CREATE INDEX IF NOT EXISTS session_principal_idx ON session (principal_id);
CREATE INDEX IF NOT EXISTS session_expires_idx   ON session (expires_at);

-- ============ OAUTH TRANSACTIONS ============
-- One row per in-flight sign-in. Holds the PKCE verifier and the CSRF state
-- between the redirect out to Microsoft and the callback coming back. Rows are
-- single-use and short-lived; the callback deletes the row it consumes.
CREATE TABLE IF NOT EXISTS auth_transaction (
  state          text PRIMARY KEY,
  code_verifier  text NOT NULL,
  nonce          text NOT NULL,
  redirect_to    text,                                   -- where to land after sign-in
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_transaction_expires_idx ON auth_transaction (expires_at);

-- ============ SUPER ADMINS ============
-- The four named accounts. Elise and Jordan already exist as seeded principals,
-- so their addresses are CORRECTED here rather than duplicated — re-inserting
-- would orphan every activity_log row already attributed to them.
UPDATE principal SET email = 'eliseam@byblosvista.com', is_super_admin = true, role = 'admin'
  WHERE display_name = 'Elise' AND kind = 'human';
UPDATE principal SET email = 'jordan@byblosvista.com',  is_super_admin = true, role = 'admin'
  WHERE display_name = 'Jordan Brown' AND kind = 'human';

-- Jeff and Jack have no seeded counterpart. They land as 'invited': the row is
-- the invitation, and the display names are placeholders the Users screen can
-- correct — better than inventing surnames.
INSERT INTO principal (kind, display_name, email, role, initials, status, is_super_admin)
  VALUES ('human', 'Jeff S', 'jeffs@byblosvista.com', 'admin', 'JS', 'invited', true)
  ON CONFLICT DO NOTHING;
INSERT INTO principal (kind, display_name, email, role, initials, status, is_super_admin)
  VALUES ('human', 'Jack',   'jack@byblosvista.com',  'admin', 'J',  'invited', true)
  ON CONFLICT DO NOTHING;

-- Everyone seeded before this migration has never signed in. Marking them
-- 'invited' keeps the distinction honest: they can be assigned work and appear
-- in the activity log, but nobody has proven they own that mailbox yet.
UPDATE principal SET status = 'invited'
  WHERE kind = 'human' AND last_login_at IS NULL AND status = 'active';
