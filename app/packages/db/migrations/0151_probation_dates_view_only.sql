-- 0151 · OM Under Probation is view-only on the Dates (Elise, 2026-11-16,
-- UAT #20).
--
-- Overview › Dates draws the Dates section (FIELD_SECTIONS 'dates'): Received
-- on, Date Created, Due Date, SLA Due Date, SLA Requested / Updated, Scheduled
-- Date, Parts Arrival Date, Quote Due Date. OM Under Probation keeps view and
-- loses edit on the whole section; an explicit edit grant on one of its
-- fields is cleared too, so nothing below the section reopens it. Raising a
-- work order is not editing one: Add work order still takes Received on and
-- Due Date (CREATE_FILLABLE_FIELD_KEYS). Loosen it in Admin › Roles or per
-- person with Adjust. role is not truncated by the seed, so this lives here only.

UPDATE role
   SET permissions = (
         SELECT COALESCE(jsonb_object_agg(k, CASE WHEN k LIKE 'work_orders/fields/dates/%' THEN v - 'edit' ELSE v END), '{}'::jsonb)
           FROM jsonb_each(COALESCE(permissions, '{}'::jsonb)) AS e(k, v)
       )
 WHERE code = 'om_probation';

UPDATE role
   SET permissions = COALESCE(permissions, '{}'::jsonb)
                     || jsonb_build_object('work_orders/fields/dates',
                          COALESCE(permissions -> 'work_orders/fields/dates', '{}'::jsonb) || '{"edit": false}'::jsonb)
 WHERE code = 'om_probation';
