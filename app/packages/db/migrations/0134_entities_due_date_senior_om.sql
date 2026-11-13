-- 0134 · Elise, 2026-11-13.
--
-- 1. Add work order: Due Date is required (WO_CREATE_REQUIRED_KEYS in
--    packages/shared/src/woCreate.ts; seed.ts re-applies the list — KEEP IN
--    STEP). Admin › Custom fields can still change it.
--
-- 2. Senior OM reads the client conversation but does not write to it:
--    `work_orders/comments/client` create false (the Messages tab's Client
--    visible lane stays open to them; its composer is locked). role is not
--    truncated by the seed, so this lives here only.
--
-- 3. AF, TPM and EDS are closed: only SFM, BKR and RF remain. History is
--    kept — work orders, quotes, invoices and payments that carry those
--    Comps are untouched and still read and print. What goes:
--      · the three values from the `21. Comp` dropdown (seed.ts in step), so
--        nothing new can pick them;
--      · their account teams (client_team), check-in rows
--        (client_cico_method) and price cards (price_card, its rates and fees
--        cascade);
--      · client records whose every team / check-in row / billing entity was
--        under a closed Comp are marked inactive (never deleted: work orders
--        still name them);
--      · contracts naming one of them are switched off.
--    The sign-off sheets for AF / TPM / EDS left the code with this change.

-- 1 ───────────────────────────────────────────────────────────────────────
UPDATE field_def SET create_mode = 'required' WHERE key = 'Due Date';

-- 2 ───────────────────────────────────────────────────────────────────────
UPDATE role
   SET permissions = COALESCE(permissions, '{}'::jsonb)
                     || jsonb_build_object(
                          'work_orders/comments/client',
                          COALESCE(permissions -> 'work_orders/comments/client', '{}'::jsonb) || '{"create": false}'::jsonb)
 WHERE code = 'senior_om';

-- 3 ───────────────────────────────────────────────────────────────────────
-- Clients that lose their last open-entity link. Worked out before anything
-- is deleted.
CREATE TEMP TABLE closed_entity_clients ON COMMIT DROP AS
SELECT c.id
  FROM client c
 WHERE c.deleted_at IS NULL
   AND (
         upper(btrim(COALESCE(c.billing_entity, ''))) IN ('AF', 'TPM', 'EDS')
      OR EXISTS (SELECT 1 FROM client_team t WHERE t.client_id = c.id AND upper(btrim(t.billing_entity)) IN ('AF', 'TPM', 'EDS'))
      OR EXISTS (SELECT 1 FROM client_cico_method m WHERE m.client_id = c.id AND upper(btrim(m.billing_entity)) IN ('AF', 'TPM', 'EDS'))
       )
   AND upper(btrim(COALESCE(c.billing_entity, ''))) NOT IN ('SFM', 'BKR', 'RF')
   AND NOT EXISTS (SELECT 1 FROM client_team t WHERE t.client_id = c.id AND upper(btrim(t.billing_entity)) NOT IN ('AF', 'TPM', 'EDS'))
   AND NOT EXISTS (SELECT 1 FROM client_cico_method m WHERE m.client_id = c.id AND upper(btrim(m.billing_entity)) NOT IN ('AF', 'TPM', 'EDS'));

UPDATE client SET is_active = false
 WHERE id IN (SELECT id FROM closed_entity_clients) AND is_active;

DELETE FROM client_team        WHERE upper(btrim(billing_entity)) IN ('AF', 'TPM', 'EDS');
DELETE FROM client_cico_method WHERE upper(btrim(billing_entity)) IN ('AF', 'TPM', 'EDS');
DELETE FROM price_card         WHERE upper(btrim(billing_entity)) IN ('AF', 'TPM', 'EDS');

UPDATE client SET billing_entity = NULL
 WHERE upper(btrim(COALESCE(billing_entity, ''))) IN ('AF', 'TPM', 'EDS');

UPDATE contract SET active = false
 WHERE upper(btrim(COALESCE(billing_entity, ''))) IN ('AF', 'TPM', 'EDS') AND active;

UPDATE field_def f
   SET type_config = jsonb_set(
         COALESCE(f.type_config, '{}'::jsonb),
         '{options}',
         COALESCE((
           SELECT jsonb_agg(o ORDER BY n)
             FROM jsonb_array_elements(COALESCE(f.type_config -> 'options', '[]'::jsonb)) WITH ORDINALITY AS x(o, n)
            WHERE upper(btrim(CASE jsonb_typeof(o) WHEN 'string' THEN o #>> '{}' ELSE COALESCE(o ->> 'name', o ->> 'value', '') END))
                  NOT IN ('AF', 'TPM', 'EDS')
         ), '[]'::jsonb))
 WHERE f.key = '21. Comp';
