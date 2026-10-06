-- 0074 · Admin › Integrations: one switch per connector.
--
-- Everything The One connects to (Quo, Ecotrak, ServiceChannel, Corrigo,
-- SharePoint, Claude, outgoing email, the escalation mailbox webhook, file
-- storage, Microsoft sign-in) is listed in code (packages/shared/src/
-- integrations.ts); this table holds the switch. Off = every code path that
-- uses the connector refuses with "switched off in Admin › Integrations";
-- the credentials stay in the server environment untouched. A key with no
-- row counts as ON, so a connector added later is on until someone turns it
-- off. Configuration with no FK: the seed leaves it alone (0012 reasoning).

CREATE TABLE integration_setting (
  key        text PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT true,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO integration_setting (key, enabled) VALUES
  ('quo', true),
  ('ecotrak', true),
  ('servicechannel', true),
  ('corrigo', true),
  ('sharepoint', true),
  ('claude', true),
  ('email', true),
  ('email_escalations', true),
  ('blob', true),
  ('entra', true);

-- Admin › Integrations is its own section (admin/integrations view / edit),
-- granted to the admin role like Vendors & map (0057) and Sites & assets
-- (0062); super admins hold every section anyway.
UPDATE role SET permissions = permissions
    || jsonb_build_object('admin/integrations', jsonb_build_object('view', true, 'edit', true))
 WHERE code = 'admin' AND NOT (permissions ? 'admin/integrations');
