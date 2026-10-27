-- 0095 · Tech Hub, a work-order tab of its own (Elise, 2026-10-27).
--
-- People › Technicians becomes the Tech Hub tab: the responsible vendor, the
-- technicians hired, the suggested vendors, dispatch, the technician calls
-- (with the AI quote draft) and the Quo technician texts. Messages keeps the
-- conversation with the team and the client, and calls to the client.
--
-- The sub-tab rode on People's permission (`work_orders/tabs/people`); it now
-- has its own row, `work_orders/tabs/technicians`, in Admin › Roles. So that
-- nobody gains or loses the tab today, every role and every per-person
-- override that set People's row gets the same on Tech Hub's — unless it
-- already says something about Tech Hub. Unset stays unset (both inherit
-- `work_orders/tabs`, so they still agree).

UPDATE role
   SET permissions = permissions
       || jsonb_build_object('work_orders/tabs/technicians', permissions -> 'work_orders/tabs/people')
 WHERE permissions ? 'work_orders/tabs/people'
   AND NOT permissions ? 'work_orders/tabs/technicians';

UPDATE principal
   SET permission_overrides = permission_overrides
       || jsonb_build_object('work_orders/tabs/technicians', permission_overrides -> 'work_orders/tabs/people')
 WHERE permission_overrides ? 'work_orders/tabs/people'
   AND NOT permission_overrides ? 'work_orders/tabs/technicians';
