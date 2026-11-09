-- 0128 · PPR Link leaves the app (Elise, 2026-11-09).
--
-- Retired the 0121 way, not deleted: `field_def.retired_at` takes it out of the
-- field catalogue, so the Payments card of All fields (its last field, Yoda
-- Link went in 0121) is no longer drawn; `resolveField` still knows it, so a
-- saved view, a tracker or an automation that names it keeps loading. The
-- values already in task.fields stay where they are.
--
-- seed.ts no longer creates it (keep in step: RETIRED_FIELD_LABELS in
-- packages/shared/src/woCreate.ts).

UPDATE field_def
   SET retired_at = now(),
       create_mode = 'off'
 WHERE retired_at IS NULL
   AND (key IN ('26. PPR Link', 'PPR Link') OR label = 'PPR Link');
