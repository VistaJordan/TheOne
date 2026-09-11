-- 0038 · Rules 7.3.1–7.3.3 — the 'Escalated' flag (the Escalation Tracker).
--
-- 7.3.1 "IF a Manager clicks Mark as Escalated THEN Is_Escalated = TRUE";
-- 7.3.2 the external email tool can raise the same flag through a webhook;
-- 7.3.3 a flagged work order reads loudly everywhere, sits at the top of the
-- manager's Approvals inbox (the unified to-do list) and has a team-wide
-- tracker view. Like the Emergency flag (0034) it is ONE checkbox custom
-- field, `Escalated`, so the list column, the filter, saved views, bulk edit,
-- per-field permissions and an audit row on every change come for free. The
-- list, the queues and the inbox project it on every row (`escalated` /
-- `wo_escalated`) so the amber reads without fetching the bag.
--
-- "A Manager": the field's own edit permission decides who may raise or
-- clear it. The dispatcher tiers (OM, OM Under Probation, Senior OM — the
-- request-mode roles of 0031) are set to view-only on it here, only where the
-- path is not already set, so a Roles-screen decision survives. Everyone
-- else inherits the Overview section's edit as before. The webhook never
-- clears the flag (a person's untick sticks — the override rule 0034 agreed).
--
-- field_def rows are seed-owned (0011's data note): seed.ts declares the same
-- row in CURATED_FIELDS; this INSERT is for an already-seeded database.
-- KEEP THE FIELD IN STEP.
INSERT INTO field_def (container_id, key, label, type, type_config, position)
SELECT c.id,
       'Escalated',
       'Escalated',
       'checkbox',
       '{}'::jsonb,
       (SELECT COALESCE(max(position), 0) + 1 FROM field_def WHERE container_id = c.id)
  FROM container c
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;

UPDATE role
   SET permissions = permissions
     || jsonb_build_object('work_orders/fields/overview/fields.Escalated', jsonb_build_object('edit', false))
 WHERE code IN ('om', 'om_probation', 'senior_om')
   AND NOT (permissions ? 'work_orders/fields/overview/fields.Escalated');
