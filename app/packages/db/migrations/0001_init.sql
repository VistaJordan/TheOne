-- ============ ENUMS ============
CREATE TYPE container_kind AS ENUM ('workspace','space','folder','list');
CREATE TYPE status_group   AS ENUM ('open','active','done','closed');
CREATE TYPE principal_kind AS ENUM ('human','service');
CREATE TYPE payable_status AS ENUM ('pending','approved','paid');
CREATE TYPE field_type AS ENUM (
  'checkbox','short_text','long_text','dropdown','date','users',
  'formula','currency','attachment','location','rating','url','number'
);  -- 13 types, all in real use

-- ============ updated_at helper ============
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

-- ============ HIERARCHY (workspace → space → folder → list) ============
-- One polymorphic table; kind discriminates the four levels; parent_id is the adjacency edge.
CREATE TABLE container (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       container_kind NOT NULL,
  parent_id  uuid REFERENCES container(id),
  name       text NOT NULL,
  ext_ref    text,                 -- original ClickUp list/folder name for traceability
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX container_parent_idx ON container(parent_id);
CREATE INDEX container_kind_idx   ON container(kind);
CREATE TRIGGER container_touch BEFORE UPDATE ON container
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ PRINCIPALS (humans + service accounts) ============
CREATE TABLE principal (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           principal_kind NOT NULL,
  display_name   text NOT NULL,
  email          text,
  role           text,             -- free-text role code (admin/member/owner/OM/AM/TL…) in v0
  initials       text,
  api_token_hash text,             -- for service accounts (hashed); NULL for humans
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER principal_touch BEFORE UPDATE ON principal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ STATUS SETS & STATUSES ============
CREATE TABLE status_set (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id uuid NOT NULL REFERENCES container(id),  -- attaches at space (or any node) — inheritance resolved app-side later
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER status_set_touch BEFORE UPDATE ON status_set
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE status (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status_set_id uuid NOT NULL REFERENCES status_set(id) ON DELETE CASCADE,
  name          text NOT NULL,
  status_group  status_group NOT NULL,     -- open/active/done/closed drives filters & KPIs
  color         text NOT NULL,             -- real ClickUp hex, e.g. '#ff3f48'
  position      int  NOT NULL,             -- pipeline order 0..n
  is_archive    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (status_set_id, name)
);
CREATE INDEX status_group_idx ON status(status_group);
CREATE TRIGGER status_touch BEFORE UPDATE ON status
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ FIELD DEFINITIONS (custom-field engine) ============
CREATE TABLE field_def (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id uuid NOT NULL REFERENCES container(id),   -- shared across the container's lists
  key          text NOT NULL,          -- key used inside task.fields JSONB (= original ClickUp field name, verbatim)
  label        text NOT NULL,          -- human label (same as key in v0, e.g. '16. Client NTE 🔴')
  type         field_type NOT NULL,
  type_config  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"options":[...]} for dropdowns, {"formula":true} etc
  position     int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (container_id, key)
);
CREATE TRIGGER field_def_touch BEFORE UPDATE ON field_def
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ TASK (Work Order) — flat record ============
CREATE TABLE task (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_number      text NOT NULL UNIQUE,        -- 'WO-39403'
  ext_name       text,                        -- client's WO name/number, e.g. 'WOT0452814'
  title          text NOT NULL,               -- first meaningful line of description
  description    text,
  home_list_id   uuid REFERENCES container(id),
  status_id      uuid NOT NULL REFERENCES status(id),
  status_group   status_group NOT NULL,       -- denormalized from status for fast filtering
  -- promoted hot columns (mirror of task.fields, written by the service layer on every write):
  billing_entity text,                        -- fields '21. Comp'
  client         text,                        -- fields 'Client'
  trade          text,                        -- fields 'Trade'
  city           text,                        -- fields 'City'
  state          text,                        -- fields 'State'
  nte            numeric(12,2),               -- fields '16. Client NTE 🔴'
  date_received  date,                        -- fields 'Date-Time Received'
  fields         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- full custom-field bag, keyed by field_def.key
  parent_task_id uuid REFERENCES task(id),    -- future subtasks; unused in v1 (schema-ready)
  priority       text,                        -- 'urgent'|'high'|'normal'|'low'|null
  deleted_at     timestamptz,                 -- soft delete
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_status_idx        ON task(status_id);
CREATE INDEX task_status_group_idx  ON task(status_group);
CREATE INDEX task_home_list_idx     ON task(home_list_id);
CREATE INDEX task_client_idx        ON task(client);
CREATE INDEX task_trade_idx         ON task(trade);
CREATE INDEX task_state_idx         ON task(state);
CREATE INDEX task_date_received_idx ON task(date_received);
CREATE INDEX task_fields_gin        ON task USING gin (fields);   -- drop if a PGlite build lacks GIN; small data tolerates it
CREATE TRIGGER task_touch BEFORE UPDATE ON task
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ TASK ↔ LIST MEMBERSHIP (routing; multi-home) ============
CREATE TABLE task_list_membership (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  list_id    uuid NOT NULL REFERENCES container(id),
  is_home    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, list_id)
);
-- exactly one home list per task:
CREATE UNIQUE INDEX one_home_list_per_task ON task_list_membership(task_id) WHERE is_home;
-- NOTE: task.home_list_id is a DENORMALIZED MIRROR of this task's is_home membership row; the
-- service/seed layer keeps the two consistent on every write. "At least one home" is APP-ENFORCED,
-- not DB-enforced: the partial unique index above guarantees at-most-one home, never at-least-one.

-- ============ ACTIVITY LOG (append-only, every mutation attributed) ============
CREATE TABLE activity_log (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_principal_id uuid NOT NULL REFERENCES principal(id),
  entity_type        text NOT NULL,        -- 'task'
  entity_id          uuid NOT NULL,
  action             text NOT NULL,        -- 'created' | 'status_changed' | 'field_updated' | 'routed'
  field              text,                 -- e.g. 'status_id'
  before             jsonb,
  after              jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_entity_idx ON activity_log(entity_type, entity_id, created_at DESC);
-- Append-only by convention: application never issues UPDATE or DELETE on this table.

-- ============ COMMENT / UPDATE (client-visibility boundary) ============
CREATE TABLE comment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id             uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  author_principal_id uuid NOT NULL REFERENCES principal(id),
  body                text NOT NULL,
  client_visible      boolean NOT NULL DEFAULT false,   -- Phase-0 schema commitment
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comment_task_idx ON comment(task_id);
CREATE TRIGGER comment_touch BEFORE UPDATE ON comment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ VENDOR (minimal — external subcontractors) ============
CREATE TABLE vendor (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  trades     text[] NOT NULL DEFAULT '{}',
  phone      text,
  city       text,
  state      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER vendor_touch BEFORE UPDATE ON vendor
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ PAYABLE (stub — tech payment tied to WO + vendor) ============
CREATE TABLE payable (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES task(id),
  vendor_id  uuid REFERENCES vendor(id),
  amount     numeric(12,2) NOT NULL DEFAULT 0,
  status     payable_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payable_task_idx ON payable(task_id);
CREATE TRIGGER payable_touch BEFORE UPDATE ON payable
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ ATTACHMENT (stub — local disk in v0) ============
CREATE TABLE attachment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        uuid REFERENCES task(id) ON DELETE CASCADE,
  comment_id     uuid REFERENCES comment(id) ON DELETE CASCADE,
  file_name      text NOT NULL,
  storage_key    text,                 -- local path in v0 → object-store key later
  content_type   text,
  byte_size      bigint,
  client_visible boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachment_task_idx ON attachment(task_id);
CREATE TRIGGER attachment_touch BEFORE UPDATE ON attachment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
