-- 0086 · UAT round 1, Wave D — data quality (docs/specs/uat-round-1.md).
--
-- #11 · One client list. Every client NAMED on a work order, a site or a PM
-- schedule gets a client record (matched by lower(btrim(name)), the 0062
-- join; the first spelling seen wins). From here on the Client on a work
-- order, a draft, a schedule and an import is checked against these records
-- (services/dataRules.ts); the Ecotrak ingest adopts a new name after its
-- commit. seed.ts runs the same INSERT after it has written its work orders —
-- keep the two in step.
INSERT INTO client (name)
SELECT DISTINCT ON (lower(btrim(n))) btrim(n)
  FROM (
    SELECT client AS n FROM task WHERE deleted_at IS NULL AND btrim(COALESCE(client, '')) <> ''
    UNION
    SELECT client FROM site WHERE deleted_at IS NULL AND btrim(COALESCE(client, '')) <> ''
    UNION
    SELECT client FROM pm_schedule WHERE btrim(COALESCE(client, '')) <> ''
  ) x
 WHERE NOT EXISTS (SELECT 1 FROM client c WHERE c.deleted_at IS NULL AND lower(btrim(c.name)) = lower(btrim(x.n)))
 ORDER BY lower(btrim(n))
ON CONFLICT DO NOTHING;

-- M30 · Rates as they stood. A rate card's rates are versioned: a work order
-- is priced (invoice prefill, completion proposals, the quote's rate panel)
-- at the version in force on the day it was RECEIVED, so editing a card
-- applies to new work only. The first version of a card reaches back forever
-- ('-infinity'); an edit that changes the rates adds one at now().
-- No FK to principal (created_by): the seed TRUNCATEs principal … CASCADE and
-- the versions must survive it, like contract itself.
CREATE TABLE IF NOT EXISTS contract_rate_version (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id    uuid NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  effective_from timestamptz NOT NULL,
  rates          jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_rate_version_contract_idx
  ON contract_rate_version (contract_id, effective_from);

-- Every card on file starts with its current rates as version one.
INSERT INTO contract_rate_version (contract_id, effective_from, rates)
SELECT c.id, '-infinity'::timestamptz,
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
                          'rate_type', r.rate_type, 'trade', r.trade,
                          'amount', r.amount, 'position', r.position)
                        ORDER BY r.position, r.created_at)
                   FROM contract_rate r WHERE r.contract_id = c.id), '[]'::jsonb)
  FROM contract c
 WHERE NOT EXISTS (SELECT 1 FROM contract_rate_version v WHERE v.contract_id = c.id);
