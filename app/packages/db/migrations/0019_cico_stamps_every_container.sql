-- 0019 · The two check-in/out stamp fields, on every container that holds a
-- catalogue.
--
-- 0018 inserted 'Checked-in At' / 'Checked-out At' only under the container of
-- kind 'space'. A database whose catalogue hangs off a different container
-- (production was not built by seed.ts) got nothing, and the CICO tab showed
-- no stamp fields even though the API was writing them into the bag. Define
-- the two fields wherever field_def rows already live; ON CONFLICT keeps a
-- database that 0018 already served unchanged.
INSERT INTO field_def (container_id, key, label, type, position)
SELECT c.container_id, v.key, v.label, 'datetime',
       (SELECT max(position) FROM field_def WHERE container_id = c.container_id) + v.n
  FROM (SELECT DISTINCT container_id FROM field_def) AS c
  CROSS JOIN (VALUES ('Checked-in At', 'Checked-in At', 1),
                     ('Checked-out At', 'Checked-out At', 2)) AS v(key, label, n)
ON CONFLICT (container_id, key) DO NOTHING;
