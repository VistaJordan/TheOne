-- 0117 · Street Address (Elise, 2026-11-02).
--
-- A work order's address is pasted whole into `17. Address` ("175 W Jackson
-- Blvd, Ste 201, Chicago, IL 60604, USA"); City, State and Zip Code have been
-- read off it since 2026-10-22 (packages/shared/src/addressParts.ts). Street
-- Address is the fourth part: everything before the city. It is filled by the
-- same code on every write path, and offered on Add work order right after
-- Address. seed.ts carries the same row and WO_CREATE_DEFAULT_KEYS lists it
-- — KEEP IN STEP. Going forward only: nothing back-fills the work orders on
-- file (the next save of their address will).

INSERT INTO field_def (container_id, key, label, type, type_config, position)
SELECT c.id, 'Street Address', 'Street Address', 'short_text'::field_type, '{}'::jsonb,
       (SELECT COALESCE(max(position), 0) FROM field_def WHERE container_id = c.id) + 1
  FROM container c
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;

UPDATE field_def SET create_mode = 'optional' WHERE key = 'Street Address' AND create_mode = 'off';
