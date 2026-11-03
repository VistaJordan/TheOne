-- 0121 · Twelve fields leave the app (Elise, 2026-11-03).
--
-- Today, Yoda Link, GTG, MOD Date, Show in CA, Sharepoint Link, MoD Call,
-- MoD Call Notes, Tech Quote, Tech Map, Work Permit Needed and Supplier Type
-- are RETIRED, not deleted: `field_def.retired_at` takes them out of the field
-- catalogue (All fields, the column picker, filters, bulk edit, Add work
-- order, Admin › Custom fields, the CSV import and the ClickUp push), while
-- `resolveField` still knows them, so a saved view, a tracker or an
-- automation that names one keeps loading instead of failing on an unknown
-- field. The values already in task.fields stay where they are.
--
-- Matched by key or label, so a database whose ClickUp import spelled a key
-- differently ("❌Today", "27. Yoda Link") is caught too. seed.ts no longer
-- creates these twelve (keep the two in step: RETIRED_FIELD_LABELS in
-- packages/shared/src/woCreate.ts lists the labels).
--
-- Ecotrak ID is not retired: it is only kept off the screens
-- (SCREEN_HIDDEN_FIELD_KEYS), because the Ecotrak sync writes it and ClickUp
-- still matches and pushes it. Parts Required and Total Invoiced stay.

ALTER TABLE field_def ADD COLUMN IF NOT EXISTS retired_at timestamptz;

UPDATE field_def
   SET retired_at = now(),
       create_mode = 'off'
 WHERE retired_at IS NULL
   AND (key IN ('❌Today', 'Today', '27. Yoda Link', 'Yoda Link', 'GTG', 'MOD Date',
                'Show in CA', '28. Sharepoint Link', 'Sharepoint Link', 'MoD Call',
                'MoD Call Notes', 'Tech Quote', 'Tech Map', 'Work Permit Needed',
                'Supplier Type')
        OR label IN ('Today', 'Yoda Link', 'GTG', 'MOD Date', 'Show in CA',
                     'Sharepoint Link', 'MoD Call', 'MoD Call Notes', 'Tech Quote',
                     'Tech Map', 'Work Permit Needed', 'Supplier Type'));
