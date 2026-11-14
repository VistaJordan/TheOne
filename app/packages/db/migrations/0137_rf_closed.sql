-- 0137 · Elise, 2026-11-14.
--
-- RF (Repairfected) is closed, as AF, TPM and EDS were in 0134: only SFM and
-- BKR remain. History is kept — work orders, quotes, invoices and payments
-- that carry RF are untouched and still read and print. What goes:
--   · RF from the `21. Comp` dropdown (seed.ts in step), so nothing new can
--     pick it;
--   · its account teams (client_team), check-in rows (client_cico_method)
--     and price cards (price_card, its rates and fees cascade);
--   · client records whose every team / check-in row / billing entity was
--     under a closed Comp are marked inactive (never deleted: work orders
--     still name them);
--   · contracts naming RF are switched off.
-- The RF sign-off sheet and its form left the code with this change.

-- Clients that lose their last open-entity link. Worked out before anything
-- is deleted.
CREATE TEMP TABLE rf_closed_clients ON COMMIT DROP AS
SELECT c.id
  FROM client c
 WHERE c.deleted_at IS NULL
   AND (
         upper(btrim(COALESCE(c.billing_entity, ''))) = 'RF'
      OR EXISTS (SELECT 1 FROM client_team t WHERE t.client_id = c.id AND upper(btrim(t.billing_entity)) = 'RF')
      OR EXISTS (SELECT 1 FROM client_cico_method m WHERE m.client_id = c.id AND upper(btrim(m.billing_entity)) = 'RF')
       )
   AND upper(btrim(COALESCE(c.billing_entity, ''))) NOT IN ('SFM', 'BKR')
   AND NOT EXISTS (SELECT 1 FROM client_team t WHERE t.client_id = c.id AND upper(btrim(t.billing_entity)) IN ('SFM', 'BKR'))
   AND NOT EXISTS (SELECT 1 FROM client_cico_method m WHERE m.client_id = c.id AND upper(btrim(m.billing_entity)) IN ('SFM', 'BKR'));

UPDATE client SET is_active = false
 WHERE id IN (SELECT id FROM rf_closed_clients) AND is_active;

DELETE FROM client_team        WHERE upper(btrim(billing_entity)) = 'RF';
DELETE FROM client_cico_method WHERE upper(btrim(billing_entity)) = 'RF';
DELETE FROM price_card         WHERE upper(btrim(billing_entity)) = 'RF';

UPDATE client SET billing_entity = NULL
 WHERE upper(btrim(COALESCE(billing_entity, ''))) = 'RF';

UPDATE contract SET active = false
 WHERE upper(btrim(COALESCE(billing_entity, ''))) = 'RF' AND active;

UPDATE field_def f
   SET type_config = jsonb_set(
         COALESCE(f.type_config, '{}'::jsonb),
         '{options}',
         COALESCE((
           SELECT jsonb_agg(o ORDER BY n)
             FROM jsonb_array_elements(COALESCE(f.type_config -> 'options', '[]'::jsonb)) WITH ORDINALITY AS x(o, n)
            WHERE upper(btrim(CASE jsonb_typeof(o) WHEN 'string' THEN o #>> '{}' ELSE COALESCE(o ->> 'name', o ->> 'value', '') END))
                  <> 'RF'
         ), '[]'::jsonb))
 WHERE f.key = '21. Comp';
