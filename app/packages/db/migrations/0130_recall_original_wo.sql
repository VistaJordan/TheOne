-- 0130 · "Is this WO a recall?" on Add work order (Elise, 2026-11-10).
--
-- Two custom fields in the Overview section (FIELD_SECTIONS in
-- packages/shared/src/permissions.ts), both on the Add work order form
-- (WO_CREATE_DEFAULT_KEYS, section "What is wrong"):
--   `Is Recall`   checkbox — the question.
--   `Original WO` short text — the WO # of the work order it recalls. The
--                 form shows it only once the box is ticked, and then it is
--                 required; it is picked from the work orders on file, and
--                 the API refuses a number no live work order answers to
--                 (applyRecallRule / ORIGINAL_WO_NOT_FOUND in shared woCreate.ts).
--
-- Not the same thing as the manager's `Recall` penalty tick (0094, Penalties),
-- which stays as it is.
--
-- seed.ts carries the same two rows (CURATED_FIELDS) and re-applies
-- WO_CREATE_DEFAULT_KEYS. KEEP IN STEP.

INSERT INTO field_def (container_id, key, label, type, type_config, position)
SELECT c.id, v.key, v.label, v.type::field_type, '{}'::jsonb,
       (SELECT COALESCE(max(position), 0) FROM field_def WHERE container_id = c.id) + v.ord
  FROM container c
  CROSS JOIN (VALUES
    ('Is Recall',   'Is this WO a recall?', 'checkbox',   1),
    ('Original WO', 'Original WO',          'short_text', 2)
  ) AS v(key, label, type, ord)
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;

UPDATE field_def
   SET create_mode = 'optional'
 WHERE key IN ('Is Recall', 'Original WO')
   AND create_mode = 'off';
