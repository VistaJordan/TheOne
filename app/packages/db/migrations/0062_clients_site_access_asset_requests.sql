-- 0062 · The rest of the portfolio (Facilio parity batch 2):
--   clients as records · a person restricted to a list of sites ·
--   asset management requests · Admin › Sites & assets.
-- (Sites and assets as a dashboard source needs no schema.)

-- ── Clients ─────────────────────────────────────────────────────────────────
-- "Client" has always been text: on the work order (task.client, a mirror of
-- the bag's 'Client'), on the site (written by the Ecotrak sync), on a
-- contract. Those stay text and stay the source of truth for which client a
-- work order belongs to — nothing here adds a foreign key to them, and the
-- Ecotrak sync is untouched. A client RECORD is what is known about that name:
-- who to talk to, where to bill, notes. It joins to the text by name, case
-- and surrounding spaces ignored.
--
-- No FK to principal (the 0060 reasoning: the seed truncates principal …
-- CASCADE and clients must survive a re-seed).

CREATE TABLE client (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  code            text,
  account_manager uuid,
  billing_entity  text,
  contact_name    text,
  contact_email   text,
  contact_phone   text,
  billing_email   text,
  address         text,
  portal_type     text,
  payment_terms   text,
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- One record per name among the live ones; a removed client frees its name.
CREATE UNIQUE INDEX client_name_idx ON client (lower(btrim(name))) WHERE deleted_at IS NULL;
CREATE TRIGGER client_touch BEFORE UPDATE ON client
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every client already named on a work order or a site gets its record. The
-- spelling kept is the most used one.
INSERT INTO client (name)
SELECT DISTINCT ON (lower(btrim(n))) btrim(n)
  FROM (
    SELECT client AS n, count(*) AS uses FROM task WHERE deleted_at IS NULL AND btrim(COALESCE(client, '')) <> '' GROUP BY client
    UNION ALL
    SELECT client, count(*) FROM site WHERE deleted_at IS NULL AND btrim(COALESCE(client, '')) <> '' GROUP BY client
  ) x
 ORDER BY lower(btrim(n)), uses DESC
ON CONFLICT DO NOTHING;

-- ── A person's sites ────────────────────────────────────────────────────────
-- Nobody listed here = no restriction. A person with rows sees only those
-- sites, their assets, and the work orders AT those sites — on top of
-- whatever their role's work-order scope (0026) already says. Super admins
-- are never restricted.

CREATE TABLE principal_site (
  principal_id uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  site_id      uuid NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  granted_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, site_id)
);
CREATE INDEX principal_site_site_idx ON principal_site (site_id);

-- ── Asset management requests ───────────────────────────────────────────────
-- Somebody on the ground asks for the asset register to change — add one,
-- replace one, retire one, move one — and a manager says yes or no. Approving
-- makes the change; the request keeps what was asked and what was decided.

CREATE TABLE asset_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL CHECK (type IN ('add', 'replace', 'retire', 'move')),
  -- The asset it is about (null for 'add'); kept if the asset is later removed.
  asset_id      uuid REFERENCES asset(id) ON DELETE SET NULL,
  -- Where: the asset's site, or for add / move the site it should be at.
  site_id       uuid REFERENCES site(id) ON DELETE SET NULL,
  reason        text NOT NULL,
  -- add / replace: the new asset's fields. move: { location_id }.
  proposed      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The work order that prompted it, as typed (no FK: see 0060).
  wo_number     text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'withdrawn')),
  requested_by  uuid,
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text,
  -- The asset an approved add / replace created.
  result_asset_id uuid REFERENCES asset(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_request_open_idx  ON asset_request (created_at) WHERE status = 'open';
CREATE INDEX asset_request_asset_idx ON asset_request (asset_id);
CREATE TRIGGER asset_request_touch BEFORE UPDATE ON asset_request
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Who may do what ─────────────────────────────────────────────────────────
-- Clients: everyone looks one up; the people who run accounts keep them.
UPDATE role SET permissions = permissions
    || jsonb_build_object('clients', jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am') AND NOT (permissions ? 'clients');
UPDATE role SET permissions = permissions
    || jsonb_build_object('clients', jsonb_build_object('view', true, 'create', false, 'edit', false, 'delete', false))
 WHERE code NOT IN ('admin', 'tl', 'atl', 'am') AND NOT (permissions ? 'clients');

-- Asset requests: anyone who may edit assets may ask; managers decide.
UPDATE role SET permissions = permissions
    || jsonb_build_object('assets/requests', jsonb_build_object('create', true, 'approve', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am') AND NOT (permissions ? 'assets/requests');
UPDATE role SET permissions = permissions
    || jsonb_build_object('assets/requests', jsonb_build_object('create', true, 'approve', false))
 WHERE code IN ('om', 'om_probation', 'senior_om', 'ops_coord', 'oa') AND NOT (permissions ? 'assets/requests');
UPDATE role SET permissions = permissions
    || jsonb_build_object('assets/requests', jsonb_build_object('create', false, 'approve', false))
 WHERE code NOT IN ('admin', 'tl', 'atl', 'am', 'om', 'om_probation', 'senior_om', 'ops_coord', 'oa')
   AND NOT (permissions ? 'assets/requests');

-- Admin › Sites & assets (the two lists; site access is super-admin only).
UPDATE role SET permissions = permissions
    || jsonb_build_object('admin/portfolio', jsonb_build_object('view', true, 'edit', true))
 WHERE code = 'admin' AND NOT (permissions ? 'admin/portfolio');
