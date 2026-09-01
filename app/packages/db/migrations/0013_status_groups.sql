-- 0013 — phase groups become data.
--
-- Admin › Workflows gains real editing (rename/add/delete statuses, add a
-- phase group). The five groups were a Postgres ENUM, which cannot grow from
-- an API call; they move to a lookup table and the two enum columns become
-- plain text with a foreign key. The seed re-creates these five rows too
-- (keep-in-step rule — see CLAUDE.md "Data: migrations and seed").
--
-- 'pending' joined the enum in 0006/0007 (blocked on a party outside
-- dispatch); it must be in the def table before the FK lands or rows already
-- assigned to it violate the constraint.

CREATE TABLE status_group_def (
  code        text PRIMARY KEY,          -- stable id used in filters/saved views
  label       text NOT NULL,             -- what the tabs and menus print
  position    int  NOT NULL,             -- tab / menu order
  is_builtin  boolean NOT NULL DEFAULT false,  -- the original five: undeletable
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO status_group_def (code, label, position, is_builtin) VALUES
  ('open',    'Open',    0, true),
  ('active',  'Active',  1, true),
  ('pending', 'Pending', 2, true),
  ('done',    'Done',    3, true),
  ('closed',  'Closed',  4, true);

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
