-- 0008 — phase groups become data.
--
-- Admin › Workflows gains real editing (rename/add/delete statuses, add a
-- phase group). The four groups were a Postgres ENUM, which cannot grow from
-- an API call; they move to a lookup table and the two enum columns become
-- plain text with a foreign key. The seed re-creates these four rows too
-- (keep-in-step rule — see CLAUDE.md "Data: migrations and seed").

CREATE TABLE status_group_def (
  code        text PRIMARY KEY,          -- stable id used in filters/saved views
  label       text NOT NULL,             -- what the tabs and menus print
  position    int  NOT NULL,             -- tab / menu order
  is_builtin  boolean NOT NULL DEFAULT false,  -- the original four: undeletable
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO status_group_def (code, label, position, is_builtin) VALUES
  ('open',   'Open',   0, true),
  ('active', 'Active', 1, true),
  ('done',   'Done',   2, true),
  ('closed', 'Closed', 3, true);

ALTER TABLE status ALTER COLUMN status_group TYPE text USING status_group::text;
ALTER TABLE task   ALTER COLUMN status_group TYPE text USING status_group::text;
DROP TYPE status_group;

ALTER TABLE status
  ADD CONSTRAINT status_group_def_fk
  FOREIGN KEY (status_group) REFERENCES status_group_def(code);

-- task.status_group is denormalized from status; the FK keeps a bad write out.
ALTER TABLE task
  ADD CONSTRAINT task_status_group_def_fk
  FOREIGN KEY (status_group) REFERENCES status_group_def(code);
