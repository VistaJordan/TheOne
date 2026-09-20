-- 0042 · Dashboards as records, shared to roles.
--
-- Until now a dashboard card was a line in one person's preferences
-- (user_pref 'dashboard.cards'): invisible to everyone else, impossible to
-- hand to a team. Facilio's model — folders of dashboards, each stating which
-- roles can see it — is what management is shown and what a dispatcher opens
-- to find their own book. These three tables carry it.
--
-- Sharing, in order of generosity:
--   owner only        shared_all = false and shared_roles = '{}'
--   named roles       shared_roles = '{om,om_probation}' (role.code values)
--   everyone          shared_all = true
-- Super admins see every dashboard, as everywhere else. The rows a dashboard
-- COUNTS are still scoped per viewer (0026/0032) — sharing decides who may
-- open the page, never what it reveals: two people opening the same dashboard
-- see their own work orders in it.
--
-- NO DATA IS INSERTED HERE. The prebuilt dashboards (Dispatch Center,
-- Approvals & bottlenecks, Money) live in packages/shared/src/dashboards.ts
-- and are upserted by ensureSystemDashboards() on the first read, keyed by
-- system_key. That is deliberate: a migration that inserted them would have to
-- be mirrored statement-for-statement in seed.ts (which truncates), and that
-- pair has drifted before. One definition, applied the same way to a seeded
-- laptop and to production.

CREATE TABLE IF NOT EXISTS dashboard_folder (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  position   int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dashboard (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id     uuid REFERENCES dashboard_folder(id) ON DELETE SET NULL,
  name          text NOT NULL,
  description   text,
  -- Set on the dashboards we ship, so they can be updated in place instead of
  -- duplicated every time the app starts. NULL for anything a person builds.
  system_key    text UNIQUE,
  owner_id      uuid REFERENCES principal(id) ON DELETE SET NULL,
  -- role.code values. Not an FK: a role removed from the table should not
  -- delete the dashboard, it should just stop matching.
  shared_roles  text[] NOT NULL DEFAULT '{}',
  shared_all    boolean NOT NULL DEFAULT false,
  position      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dashboard_folder_idx ON dashboard(folder_id);
CREATE INDEX IF NOT EXISTS dashboard_owner_idx  ON dashboard(owner_id);

CREATE TABLE IF NOT EXISTS dashboard_widget (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id uuid NOT NULL REFERENCES dashboard(id) ON DELETE CASCADE,
  -- 'number' | 'bar' | 'donut' | 'table'
  kind         text NOT NULL,
  label        text NOT NULL,
  -- What to count and how to cut it: {metric, value_field, group_field,
  -- filters, limit, columns}. Shapes live in packages/shared/src/dashboards.ts
  -- and are validated on the way in; a widget whose field was since deleted
  -- renders as "field missing" rather than breaking the page.
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 'quarter' | 'half' | 'full' — how wide it sits on the grid.
  width        text NOT NULL DEFAULT 'half',
  position     int  NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dashboard_widget_dash_idx ON dashboard_widget(dashboard_id, position);

ALTER TABLE dashboard_widget
  DROP CONSTRAINT IF EXISTS dashboard_widget_kind_check;
ALTER TABLE dashboard_widget
  ADD CONSTRAINT dashboard_widget_kind_check
  CHECK (kind IN ('number', 'bar', 'donut', 'table'));

ALTER TABLE dashboard_widget
  DROP CONSTRAINT IF EXISTS dashboard_widget_width_check;
ALTER TABLE dashboard_widget
  ADD CONSTRAINT dashboard_widget_width_check
  CHECK (width IN ('quarter', 'half', 'full'));

-- The two tables keep their own updated_at, like every other table here.
CREATE TRIGGER dashboard_touch BEFORE UPDATE ON dashboard
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER dashboard_widget_touch BEFORE UPDATE ON dashboard_widget
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER dashboard_folder_touch BEFORE UPDATE ON dashboard_folder
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Who may BUILD one. Reading dashboards already comes with the section; the
-- create grant is new, so without this nobody but a super admin could make
-- one. Managers get it: Admin, Team Lead, Assistant TL and Account Manager —
-- the same roles that decide status requests and acceptances (0031, 0036).
-- Only where the path is not already set, so a Roles-screen decision survives
-- a re-run. Role rows are migration-owned (seed.ts never truncates `role`),
-- so nothing here needs mirroring in the seed.
UPDATE role
   SET permissions = permissions
     || jsonb_build_object('dashboard', jsonb_build_object('view', true, 'create', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am')
   AND NOT (permissions ? 'dashboard');
