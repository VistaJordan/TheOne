-- 0071 · SharePoint folders.
--
-- The team keeps one folder per work order in its SharePoint library, filed
-- under the client, under the billing entity, under the year:
--
--   Documents / General / Work Orders - 2026 / 2026 - SFM / Bashas / WO#345437406, Phoenix, AZ
--
-- From here the app makes those folders itself — one for each client added
-- under Clients, one for each work order created — and copies approved files
-- into the work-order folder. Each switch is its own setting in Admin ›
-- Settings, off until an admin turns it on; the site and the credentials come
-- later (the credentials by environment, SHAREPOINT_TENANT_ID / _CLIENT_ID /
-- _CLIENT_SECRET, falling back to the mail and sign-in registrations).
--
-- Nothing here writes to Ecotrak or any client system: SharePoint is ours.

-- ── Settings ─────────────────────────────────────────────────────────────────
-- Configuration, so the seed does not truncate it — which is why updated_by is
-- a plain uuid and not a foreign key (the 0057 reasoning).
CREATE TABLE sharepoint_setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sharepoint_setting (key, value) VALUES ('config', jsonb_build_object(
  'site_url',             NULL,
  'library',              'Documents',
  'root_path',            'General/Work Orders - {year}',
  'entity_folder',        '{year} - {entity}',
  'wo_folder',            'WO#{number}, {city}, {state}',
  'client_folders',       false,
  'wo_folders',           false,
  'copy_files',           false,
  'client_folders_since', NULL,
  'wo_folders_since',     NULL,
  'copy_files_since',     NULL
));

-- ── One row per folder the app owns ──────────────────────────────────────────
-- kind = 'client' (entity_id = client.id) or 'work_order' (entity_id =
-- task.id). `path` is from the library root; item_id / web_url come back
-- from Graph once the folder exists. A row stays `pending` until Graph says
-- yes, goes `failed` with its reason (and is retried by the hourly sweep,
-- up to a limit), or `skipped` when the record cannot be filed at all (no
-- billing entity, no client name). Text ids, no foreign keys: the seed
-- truncates task and client, and a folder row outliving its record is a
-- trace, not an error.
CREATE TABLE sharepoint_folder (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('client', 'work_order')),
  entity_id   text NOT NULL,
  entity_name text NOT NULL,
  path        text NOT NULL,
  item_id     text,
  web_url     text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'created', 'failed', 'skipped')),
  error       text,
  attempts    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sharepoint_folder_entity_idx ON sharepoint_folder (kind, entity_id);
CREATE INDEX sharepoint_folder_status_idx ON sharepoint_folder (status, updated_at);
CREATE TRIGGER sharepoint_folder_touch BEFORE UPDATE ON sharepoint_folder
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── One row per approved file copied into a work-order folder ────────────────
CREATE TABLE sharepoint_file (
  attachment_id uuid PRIMARY KEY,
  task_id       uuid NOT NULL,
  file_name     text NOT NULL,
  path          text,
  item_id       text,
  web_url       text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'copied', 'failed', 'skipped')),
  error         text,
  attempts      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sharepoint_file_task_idx ON sharepoint_file (task_id);
CREATE INDEX sharepoint_file_status_idx ON sharepoint_file (status, updated_at);
CREATE TRIGGER sharepoint_file_touch BEFORE UPDATE ON sharepoint_file
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
