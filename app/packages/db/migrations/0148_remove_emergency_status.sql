-- 0148 · The "Emergency" status is gone (Elise, 2026-11-16).
--
-- An emergency is the Emergency checkbox (0034, the red rail and badge and
-- the header's Emergency button), not a place in the pipeline. Work orders
-- sitting in the status move to Open — each move is a `status_changed` row
-- (`via: 'migration'`, signed by the "Status cleanup" service principal) and
-- the Emergency box is ticked on them so none loses its red — then the
-- status is deleted. seed.ts no longer creates it (keep in step).

INSERT INTO principal (kind, display_name, role, initials)
SELECT 'service', 'Status cleanup', 'service', 'SC'
 WHERE NOT EXISTS (SELECT 1 FROM principal WHERE kind = 'service' AND display_name = 'Status cleanup')
   AND EXISTS (SELECT 1 FROM status WHERE lower(btrim(name)) = 'emergency');

WITH em AS (
  SELECT id, status_set_id, name FROM status WHERE lower(btrim(name)) = 'emergency'
), target AS (
  SELECT DISTINCT ON (em.id) em.id AS from_id, em.name AS from_name, s.id AS to_id, s.name AS to_name, s.status_group AS to_group
    FROM em
    JOIN status s ON lower(btrim(s.name)) = 'open'
   ORDER BY em.id, (s.status_set_id = em.status_set_id) DESC, s.position
), hit AS (
  SELECT t.id, t.fields -> 'Emergency' AS was_emergency, target.*
    FROM task t
    JOIN target ON t.status_id = target.from_id
), moved AS (
  UPDATE task t
     SET status_id = hit.to_id,
         status_group = hit.to_group,
         fields = COALESCE(t.fields, '{}'::jsonb) || '{"Emergency": true}'::jsonb
    FROM hit
   WHERE t.id = hit.id
  RETURNING t.id
), actor AS (
  SELECT id FROM principal WHERE kind = 'service' AND display_name = 'Status cleanup' LIMIT 1
)
INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
SELECT (SELECT id FROM actor), 'task', h.id::text, 'status_changed', 'status_id',
       jsonb_build_object('status_id', h.from_id, 'status_name', h.from_name),
       jsonb_build_object('status_id', h.to_id, 'status_name', h.to_name, 'via', 'migration',
                          'reason', 'The Emergency status was removed; the Emergency box is ticked instead')
  FROM hit h JOIN moved m ON m.id = h.id
UNION ALL
SELECT (SELECT id FROM actor), 'task', h.id::text, 'field_updated', 'fields.Emergency',
       jsonb_build_object('value', h.was_emergency),
       jsonb_build_object('value', true, 'via', 'migration')
  FROM hit h JOIN moved m ON m.id = h.id
 WHERE h.was_emergency IS DISTINCT FROM 'true'::jsonb;

-- An Ecotrak status mapped onto Emergency maps onto Open from here on.
UPDATE cmms_status_map m
   SET status_id = (SELECT o.id FROM status o WHERE lower(btrim(o.name)) = 'open' ORDER BY o.position LIMIT 1)
 WHERE m.status_id IN (SELECT id FROM status WHERE lower(btrim(name)) = 'emergency');

DELETE FROM status s
 WHERE lower(btrim(s.name)) = 'emergency'
   AND NOT EXISTS (SELECT 1 FROM task t WHERE t.status_id = s.id);
