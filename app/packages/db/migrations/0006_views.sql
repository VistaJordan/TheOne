-- ============================================================================
-- 0006 · Saved views
--
-- The work-order list stopped being one fixed table with one fixed set of
-- columns: a user now picks which columns they see, filters on any field,
-- groups the rows, and saves that arrangement so it survives a reload and can
-- be handed to a teammate.
--
-- The arrangement is stored as data rather than in localStorage on purpose. A
-- view is a work artefact — "Chicago HVAC waiting on approval, sorted by age" —
-- and an operator expects to find it on whatever machine they sign in from, and
-- to be able to share it with the person covering their shift.
--
-- `columns` / `filters` / `sort` are JSONB rather than child tables. They are
-- read and written whole, never queried into, and their vocabulary (which
-- operators exist, which fields are filterable) is owned by the API's field
-- catalogue — which itself changes whenever somebody adds a custom field. A
-- relational shape here would need a migration every time that vocabulary grew.
-- ============================================================================

CREATE TABLE IF NOT EXISTS saved_view (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_principal_id uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  -- Which list the view belongs to. Only 'work_order' exists today; quotes and
  -- payables get the same treatment later and this column is what keeps their
  -- views from colliding with these.
  entity             text NOT NULL DEFAULT 'work_order',
  name               text NOT NULL,
  -- Ordered column keys, e.g. ["wo_number","client","status","nte"].
  columns            jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- { "match": "all" | "any", "rules": [ { field, op, value } ] }
  filters            jsonb NOT NULL DEFAULT '{"match":"all","rules":[]}'::jsonb,
  -- A field key to bucket rows by, or NULL for a flat list.
  group_by           text,
  -- { "field": "date_received", "dir": "desc" }
  sort               jsonb,
  -- A shared view is visible to everyone; only its owner may edit or delete it.
  is_shared          boolean NOT NULL DEFAULT false,
  position           int NOT NULL DEFAULT 100,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_principal_id, entity, name)
);

CREATE INDEX IF NOT EXISTS saved_view_owner_idx  ON saved_view (owner_principal_id, entity);
CREATE INDEX IF NOT EXISTS saved_view_shared_idx ON saved_view (entity) WHERE is_shared;

DROP TRIGGER IF EXISTS saved_view_touch ON saved_view;
CREATE TRIGGER saved_view_touch BEFORE UPDATE ON saved_view
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
