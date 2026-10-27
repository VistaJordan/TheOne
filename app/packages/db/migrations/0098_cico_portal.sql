-- 0098 · Which portal, for the FMs whose techs check in on the client's
-- portal (Elise, 2026-10-27).
--
-- Admin › Custom fields › Check-in method by FM already says HOW an FM's
-- techs check in (IVR, Portal, Email …) and the instruction that goes with
-- it. When the method is Portal it now also says WHICH portal (Service
-- Channel, Corrigo, Ecotrak …), so a visit logged on that FM's work order
-- reads "Portal: Service Channel".
--
--   fm_cico_method.portal   the portal's name; kept only while the method is
--                           Portal (setCicoMethod clears it otherwise)
--   wo_visit.method_portal  copied onto the visit with the method when it is
--                           logged (editable there), so the visit keeps what
--                           was true at the time — the 0028 rule for detail
--
-- No row is filled in here: which portal each FM uses is the operation's
-- knowledge, typed in the admin card. Nothing is truncated by the seed for
-- this (fm_cico_method rows carry no portal in seed.ts either — keep in step).

ALTER TABLE fm_cico_method ADD COLUMN IF NOT EXISTS portal text;
ALTER TABLE wo_visit       ADD COLUMN IF NOT EXISTS method_portal text;
