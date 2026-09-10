-- ============================================================================
-- 0005 · Roles as data
--
-- Until now a role was a free-text string on `principal.role`, and the two
-- permissions in the product were hardcoded arrays in packages/shared
-- (QUOTE_EDIT_ROLES / QUOTE_APPROVE_ROLES). That meant a new role could only be
-- created by editing TypeScript and redeploying, and a typo produced a role
-- that silently passed no gate.
--
-- This table makes roles administrable. `principal.role` stays a text column
-- holding the role CODE — now with a foreign key — so every existing gate,
-- query and seeded row keeps working untouched while the source of truth moves
-- into the database.
--
-- The vocabulary seeded below is the one product/feature-roadmap.md §L1 asks
-- for at S5: "TL / ATL / AM / OA / OM (coordinator→senior) / AR (probation→HAR)
-- / AP / exec guest / admin". The previous migration only had the six codes the
-- ClickUp export happened to imply.
-- ============================================================================

CREATE TABLE IF NOT EXISTS role (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE,   -- stored on principal.role
  label              text NOT NULL,
  description        text,
  -- System roles are the ones the app's own logic and the seed refer to by
  -- name. They can be renamed and re-permissioned but never deleted, so an
  -- administrator cannot remove the role their own account depends on.
  is_system          boolean NOT NULL DEFAULT false,
  -- Capabilities. Deliberately a short, honest list: exactly the gates the
  -- server actually enforces today. A checkbox for a permission nothing checks
  -- is worse than no checkbox, because it reads as protection that is not there.
  can_edit_quote     boolean NOT NULL DEFAULT false,
  can_approve_quote  boolean NOT NULL DEFAULT false,
  can_manage_users   boolean NOT NULL DEFAULT false,
  position           int NOT NULL DEFAULT 100,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS role_touch ON role;
CREATE TRIGGER role_touch BEFORE UPDATE ON role
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── The roadmap's L1 vocabulary ─────────────────────────────────────────────
-- edit  = build / revise / submit a quote   (was QUOTE_EDIT_ROLES)
-- appr  = approve / reject / send to CMMS   (was QUOTE_APPROVE_ROLES)
-- users = the admin console
INSERT INTO role (code, label, description, is_system, can_edit_quote, can_approve_quote, can_manage_users, position) VALUES
  ('admin',      'Admin',            'Full access to every module and the admin console.',                    true,  true,  true,  true,  10),
  ('tl',         'Team Lead',        'Accept/decline authority; audits quotes; pushes to the client CMMS.',    true,  true,  true,  false, 20),
  ('atl',        'Assistant TL',     'Same touchpoints as the Team Lead.',                                     true,  true,  true,  false, 30),
  ('am',         'Account Manager',  'Owns the client relationship; accept/decline authority.',                 true,  true,  true,  false, 40),
  ('oa',         'Operations Admin', 'Intake into the system; pushes approved quotes to the client CMMS.',      true,  false, false, false, 50),
  ('senior_om',  'Senior OM',        'Senior dispatcher. Builds and revises quotes.',                           true,  true,  false, false, 60),
  ('om',         'OM (dispatcher)',  'Sources technicians, dispatches, soft-closes. Cannot build quotes.',      true,  false, false, false, 70),
  ('ops_coord',  'Ops Coordinator',  'Dispatcher under probation — reduced-trust tier of OM.',                  true,  false, false, false, 80),
  ('ar',         'Accounts Receivable', 'AR audit and collections.',                                            true,  false, false, false, 90),
  ('ap',         'Accounts Payable',  'Processes technician payments; orders parts.',                           true,  false, false, false, 100),
  ('exec_guest', 'Exec guest',       'Read-only curated rollup. No cost or profit fields.',                     true,  false, false, false, 110),
  ('service',    'Service account',  'Bots and integrations (n8n, sync jobs). Not a human login.',              true,  false, false, false, 200)
ON CONFLICT (code) DO NOTHING;

-- Defensive: adopt any role code already sitting on a principal that the list
-- above does not cover, so adding the foreign key below cannot fail on data
-- that is already in the table.
INSERT INTO role (code, label, description, is_system, position)
  SELECT DISTINCT p.role, p.role, 'Adopted from existing data during migration 0005.', false, 500
    FROM principal p
   WHERE p.role IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM role r WHERE r.code = p.role)
ON CONFLICT (code) DO NOTHING;

-- Now the code on a principal is guaranteed to name a real role.
ALTER TABLE principal DROP CONSTRAINT IF EXISTS principal_role_fkey;
ALTER TABLE principal
  ADD CONSTRAINT principal_role_fkey
  FOREIGN KEY (role) REFERENCES role(code) ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS principal_role_idx ON principal (role);

-- Super admin stays a separate boolean rather than becoming a role: it is an
-- orthogonal grant (who administers the system) not a position in the
-- operating hierarchy (what you do on a work order). Collapsing the two would
-- force every super admin to also be an 'admin' in the dispatch sense.
UPDATE role SET can_manage_users = true WHERE code = 'admin';
