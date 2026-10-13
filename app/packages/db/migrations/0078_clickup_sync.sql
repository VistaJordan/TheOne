-- 0078 · ClickUp: every new work order lands in the team's ClickUp, and every
-- change made in The One follows it there. ONE-WAY: The One is the source of
-- truth; an edit made in ClickUp is overwritten by the next change here and
-- nothing is read back.
--
-- How it runs (apps/api/src/services/clickup.ts): a work order created after
-- the switch was first turned on gets a `clickup_link` row; any activity_log
-- row on it marks the link dirty; the runner (after every write, and a
-- once-a-minute Vercel cron as the backstop) creates the ClickUp task in the
-- configured List or pushes only the mapped values that differ from what it
-- last pushed (`pushed`). Work orders older than `sync_from` (today: mock
-- data) are never sent. ClickUp's own automations move the task out of the
-- Incoming list on assignment; its id does not change, so updates follow it.
--
-- Configuration, no FK: the seed leaves `clickup_config` and
-- `clickup_field_map` alone (0012 reasoning); `clickup_link` hangs off task
-- and is emptied with it.

CREATE TABLE clickup_config (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  list_id       text,
  list_name     text,
  list_url      text,
  -- What ClickUp said about the List the last time it was read: its custom
  -- fields (with dropdown options), its statuses, and the workspace members
  -- (matched to our people by email).
  cu_fields     jsonb NOT NULL DEFAULT '[]'::jsonb,
  cu_statuses   jsonb NOT NULL DEFAULT '[]'::jsonb,
  cu_members    jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at    timestamptz,
  -- Set the first time the runner works with the switch on: only work orders
  -- created from then on go to ClickUp.
  sync_from     timestamptz,
  cursor_log_id bigint NOT NULL DEFAULT 0,
  lease_until   timestamptz,
  last_run_at   timestamptz,
  last_run_note text,
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO clickup_config (id) VALUES (1);

-- Which of our fields goes where. `source` is our key ('title', 'status',
-- 'priority', 'description', 'wo_number', 'ext_name' or 'fields.<bag key>');
-- `target` is 'name' | 'description' | 'status' | 'priority' | 'assignees' |
-- 'due_date' | 'start_date' | 'custom' (with `cu_field_id`) | 'none'. A
-- source with no row takes the automatic match by name.
CREATE TABLE clickup_field_map (
  source      text PRIMARY KEY,
  target      text NOT NULL,
  cu_field_id text,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clickup_link (
  task_id         uuid PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  clickup_task_id text,
  clickup_url     text,
  -- Last value pushed per target ('name', 'status', 'cf:<field id>', …).
  pushed          jsonb NOT NULL DEFAULT '{}'::jsonb,
  dirty           boolean NOT NULL DEFAULT true,
  dirty_since     timestamptz NOT NULL DEFAULT now(),
  attempts        int NOT NULL DEFAULT 0,
  next_try_at     timestamptz,
  last_error      text,
  last_error_at   timestamptz,
  synced_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clickup_link_dirty_idx ON clickup_link(dirty_since) WHERE dirty;

-- The connector ships OFF: nothing goes out until an administrator has
-- pasted the List and turned it on in Admin › Integrations.
INSERT INTO integration_setting (key, enabled) VALUES ('clickup', false)
ON CONFLICT (key) DO NOTHING;
