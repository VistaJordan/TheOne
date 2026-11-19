-- 0160 · OM and Senior OM are view-only on the Dates too (Elise, 2026-11-19).
--
-- 0151 did this for OM Under Probation; now every OM tier. The Dates section
-- (FIELD_SECTIONS 'dates') is what Overview › Dates and All fields draw:
-- Received on, Date Created, Due Date, SLA Due Date, SLA Requested / Updated,
-- Scheduled Date, Parts Arrival Date, Quote Due Date. OM and Senior OM keep
-- view and lose edit on the whole section; an explicit edit grant on one of
-- its fields is cleared too (0085 had set four of them to edit false), so
-- nothing below the section reopens it. Raising a work order is not editing
-- one: Add work order still takes Received on, Due Date and SLA Due Date
-- (CREATE_FILLABLE_FIELD_KEYS). Per-person overrides are untouched. Loosen it
-- in Admin › Roles or per person with Adjust. role is not truncated by the
-- seed, so this lives here only.

UPDATE role
   SET permissions = (
         SELECT COALESCE(jsonb_object_agg(k, CASE WHEN k LIKE 'work_orders/fields/dates/%' THEN v - 'edit' ELSE v END), '{}'::jsonb)
           FROM jsonb_each(COALESCE(permissions, '{}'::jsonb)) AS e(k, v)
       )
 WHERE code IN ('om', 'senior_om');

UPDATE role
   SET permissions = COALESCE(permissions, '{}'::jsonb)
                     || jsonb_build_object('work_orders/fields/dates',
                          COALESCE(permissions -> 'work_orders/fields/dates', '{}'::jsonb) || '{"edit": false}'::jsonb)
 WHERE code IN ('om', 'senior_om');
