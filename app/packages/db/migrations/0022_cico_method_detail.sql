-- ============================================================================
-- 0022 · Check-in method detail, and the operation's own FM → method table
--
-- The "database of the method for each client" turned out to be two things
-- per FM: the KIND of check-in (IVR, Portal, Email, Operator …) and the
-- INSTRUCTION that goes with it — the IVR phone number, "Service Channel",
-- "Submit request on Teams (must add photos)". 0021 stored only the kind.
--
--   fm_cico_method.detail   the instruction, shown on the visit log beside the
--                           method so the dispatcher sees the number to call
--   wo_visit.method_detail  copied onto the visit when it is logged (and
--                           editable there), so the visit keeps what was true
--                           at the time even if the FM's entry changes later
--
-- The legacy 'CICO Method' bag field now mirrors "<method> - <detail>", which
-- is exactly the shape the operation already wrote by hand ("IVR - (866)
-- 254-8780"), so old and new values read alike in the list and in exports.
--
-- The rows below are the operation's real table (Elise, 2026-09-08); they
-- upsert so a production database gets them from the migration alone and a
-- later edit in Admin › Custom fields is never reverted by a re-run (the
-- migration runs once). seed.ts carries the same rows — keep in step.
-- ============================================================================

ALTER TABLE fm_cico_method ADD COLUMN IF NOT EXISTS detail text;
ALTER TABLE wo_visit       ADD COLUMN IF NOT EXISTS method_detail text;

INSERT INTO fm_cico_method (fm, method, detail) VALUES
  ('FrontStreet', 'IVR', '(866) 254-8780'),
  ('Lessen', 'Portal', 'Submit request on Teams'),
  ('Powerhouse', 'Portal', 'Submit request on Teams (must add photos)'),
  ('Ferrandino & Son', 'Email', 'Submit request on Teams'),
  ('Freshco', 'Email', 'Submit request on Teams'),
  ('Impact', 'Email', 'Submit request on Teams'),
  ('Advanced', 'IVR', '(866) 254-8347'),
  ('Nest', 'IVR', '(877) 374-2054'),
  ('OReilly', 'IVR', 'Service Channel'),
  ('Outback Steakhouse', 'IVR', 'Service Channel'),
  ('SHEER', 'Operator', 'Submit request on Teams'),
  ('RESQ', 'Portal', 'Submit request on Teams (must add photos and the manager''s name)'),
  ('HERO', 'Email', 'Submit request on Teams'),
  ('Davaco', 'IVR', '(833) 948-2261'),
  ('KFM24', 'IVR', '(301) 854-6776'),
  ('PRS', 'IVR', 'Service Channel'),
  ('TrueSource', 'Operator', 'Submit request on Teams'),
  ('Vixxo', 'IVR', '(888) 928-3276 (if you''re new and a live operator answers, hang up)'),
  ('Canteen', 'Email', 'Submit request on Teams'),
  ('Extra Space', 'Email', 'Submit request on Teams'),
  ('ONO-BBQ', 'Email', 'Submit request on Teams'),
  ('CHEESECAKE FACTORY', 'IVR', 'Service Channel'),
  ('DinTai', 'IVR', 'Service Channel'),
  ('FedEx', 'IVR', 'Service Channel'),
  ('First Watch', 'IVR', 'Service Channel'),
  ('JRSK', 'IVR', 'Service Channel'),
  ('Habit Burger', 'IVR', 'Service Channel'),
  ('KINDERCARE', 'IVR', 'Service Channel'),
  ('Mobettahs', 'IVR', 'Service Channel'),
  ('Rural King', 'IVR', 'Service Channel'),
  ('AMC', 'Portal', 'Submit request on Teams'),
  ('Bashas', 'Portal', 'Submit request on Teams'),
  ('Learning', 'Portal', 'Submit request on Teams'),
  ('MACYS', 'Portal', 'Submit request on Teams'),
  ('Portland Leather', 'Portal', 'Submit request on Teams'),
  ('SizzlingPlatter', 'Portal', 'Submit request on Teams'),
  ('Swig Stores', 'Portal', 'Submit request on Teams'),
  ('Uncommon Brands', 'Portal', 'Submit request on Teams'),
  ('Vuori', 'Portal', 'Submit request on Teams'),
  ('Wendy''s', 'Portal', 'Submit request on Teams'),
  ('BOSS', 'IVR', '(877) 841-0301')
ON CONFLICT (fm) DO UPDATE SET method = EXCLUDED.method, detail = EXCLUDED.detail, updated_at = now();
