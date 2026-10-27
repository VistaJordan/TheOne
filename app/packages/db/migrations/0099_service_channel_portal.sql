-- 0099 · The Service Channel FMs check in on the Service Channel portal
-- (Elise, 2026-10-27).
--
-- 0028 filed twelve FMs as method IVR with the detail "Service Channel"
-- (O'Reilly, Outback, PRS, Cheesecake Factory, DinTai, FedEx, First Watch,
-- JRSK, Habit Burger, KinderCare, Mobettahs, Rural King). Their techs check
-- in through the Service Channel portal, so with 0098's portal column they
-- become method Portal, portal "Service Channel"; the detail said only the
-- portal's name and is cleared. A new visit on their work orders then reads
-- "Portal: Service Channel". Visits already logged keep what they recorded.
--
-- Only rows still exactly as 0028 wrote them move, so an admin's later edit
-- is never overwritten. seed.ts carries the same rows — keep in step.

UPDATE fm_cico_method
   SET method = 'Portal', portal = 'Service Channel', detail = NULL, updated_at = now()
 WHERE method = 'IVR'
   AND btrim(detail) = 'Service Channel';
