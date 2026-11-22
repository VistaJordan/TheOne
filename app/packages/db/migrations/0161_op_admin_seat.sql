-- 0161 · OP Admin on the work order (Elise, 2026-11-19).
--
-- `OP Admin` (users, People section): the OP Admin on the work order. Its
-- picker lists `oa` accounts only and the API refuses any other name a person
-- adds (OA_SEAT_KEY / ROLE_LIMITED_PERSON_FIELDS in
-- packages/shared/src/dataQuality.ts). It counts as "on the job"
-- (ASSIGNED_SEAT_KEYS). While OBI → Ecotrak is off, the OP Admin named here
-- moves the status and checks in / out directly and decides the dispatchers'
-- status and check-in / check-out requests on the work order
-- (apps/api/src/services/oaInterim.ts); once it is on, OP Admin requests like
-- a dispatcher, as the role already says.
--
-- seed.ts carries the same row. KEEP IN STEP.

INSERT INTO field_def (container_id, key, label, type, type_config, position)
SELECT c.id, 'OP Admin', 'OP Admin', 'users'::field_type, '{}'::jsonb,
       (SELECT COALESCE(max(position), 0) FROM field_def WHERE container_id = c.id) + 1
  FROM container c
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;
