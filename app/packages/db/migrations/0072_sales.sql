-- 0072 · Sales: a role that opens one dashboard, counted over the clients
-- assigned to them.
--
-- The sales team does not work the work orders; they want to know how many
-- came in for THEIR clients. Three pieces, none of them a new mechanism:
--
--   role 'sales'       opens the Dashboard section and the shipped "Sales"
--                      board only (0050 grants). Its "Which work orders" is
--                      Only theirs (0032); a salesperson is never the Assignee,
--                      so on its own that is nothing at all.
--   principal_client   the clients a person is assigned in Admin › Users.
--                      Rows here WIDEN "Only theirs": every work order whose
--                      Client is one of them counts as theirs — on the
--                      dashboard and anywhere else their role lets them look
--                      (one predicate, woScopeSql in services/woScope.ts).
--                      Nobody listed = nothing added. Super admins see
--                      everything regardless.
--   the Sales board    lives in packages/shared/src/dashboards.ts like every
--                      shipped board and is inserted by ensureSystemDashboards
--                      on the first read; the grant below names it ahead of
--                      time so the role opens it the moment it exists.
--
-- Which sections and sub-sections a salesperson sees is decided where it is
-- for every other role: Admin › Roles, and per person from Adjust.
--
-- `client` has no FK to principal on purpose (0062: clients survive a
-- re-seed); this join table cascades from both sides, like principal_site.

CREATE TABLE IF NOT EXISTS principal_client (
  principal_id uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  client_id    uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  granted_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, client_id)
);
CREATE INDEX IF NOT EXISTS principal_client_client_idx ON principal_client (client_id);

INSERT INTO role (code, label, description, is_system, position) VALUES
  ('sales', 'Sales', 'Sales team. Opens the Sales dashboard for the clients assigned to them in Admin › Users; nothing else.', true, 85)
ON CONFLICT (code) DO NOTHING;

-- Defaults first, then whatever the role already holds on top — a Roles-screen
-- decision made before this ran is kept.
UPDATE role
   SET permissions = jsonb_build_object(
         'dashboard',              jsonb_build_object('view', true),
         'dashboard/boards',       jsonb_build_object('view', false),
         'dashboard/boards/sales', jsonb_build_object('view', true),
         'work_orders/scope',      jsonb_build_object('view', false)
       ) || permissions
 WHERE code = 'sales';
