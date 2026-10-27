-- 0100 · The check-in method per client and billing entity (Elise,
-- 2026-10-27). Vocabulary: packages/shared/src/clientCico.ts; the API:
-- services/clientCico.ts and methodForTask in services/visits.ts; edited on
-- Clients › a client › Check-in method.
--
-- How a technician checks in depends on the client and on which of our
-- companies bills the work — the "CICO methods" sheet is keyed exactly like
-- the account-team sheet of 0096: Company (the work order's `21. Comp`) +
-- Client (a client record). So the method is one row per (client, Comp):
--
--   method   IVR · Portal · Email · Operator · App · Manual (VISIT_METHODS)
--   portal   which portal, kept only while the method is Portal (the 0098
--            rule: "Portal: Corrigo")
--   detail   the instruction shown on the visit: the IVR number, "Picture +
--            manager name"; for a method that is not Portal the sheet's
--            portal column is put in front of it ("Service Channel · (516)
--            500-7776") so an IVR row still says whose IVR it is
--   email    the mailbox the work is handled from (Contact@seamlessfm.com,
--            support@alphafixers.com …), lower-cased
--
-- A new visit takes the row for its work order's Client + Comp (a client with
-- a single row uses it when the Comp is blank); with no row it falls back to
-- the FM table (fm_cico_method, 0027 / 0028 / 0098), which stays as it is.
--
-- No FK to principal (updated_by is a plain uuid) and the seed truncates
-- neither `client` nor this table, so the rows survive a re-seed like the
-- account teams. Clients on the sheet with no record yet get one (matched
-- lower(btrim(name)), the 0062 join), as 0096 did. The sheet is loaded as
-- given (trailing spaces trimmed; "EcoTrack" spelled Ecotrak as everywhere
-- else in the app).

CREATE TABLE client_cico_method (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  billing_entity text NOT NULL CHECK (btrim(billing_entity) <> ''),
  method         text NOT NULL CHECK (btrim(method) <> ''),
  portal         text,
  detail         text,
  email          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid
);

CREATE UNIQUE INDEX client_cico_method_one_per_entity ON client_cico_method (client_id, upper(btrim(billing_entity)));

CREATE TEMP TABLE cico_sheet (comp text, client text, portal text, email text, method text, notes text) ON COMMIT DROP;
INSERT INTO cico_sheet VALUES
  ('SFM', '7-11', '7-11', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'Flynn Group', 'EcoTrack', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'PCRK', 'EcoTrack', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'MOD Pizza', 'EcoTrack', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'WKS', 'Corrigo', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'Riser Fitness', 'Seamgo', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'Green Thumb', 'EcoTrack', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'Qdoba', 'Service Channel', 'Contact@seamlessfm.com', 'IVR', '(516) 500-7776'),
  ('SFM', 'Puttshack', 'EcoTrack', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', '5Guys', 'FEXA', 'Service@seamlessfm.com', 'IVR', ''),
  ('SFM', 'DoorDash', 'Service Channel', 'Contact@seamlessfm.com', 'IVR', '(516) 500-7776'),
  ('SFM', 'OXXO', 'Corrigo', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'Macy''s', 'Service Channel', 'Contact@seamlessfm.com', 'IVR', '(516) 500-7776'),
  ('SFM', 'Planned Parenthood', 'Email', 'Contact@seamlessfm.com', 'Email', ''),
  ('SFM', 'Vuori', 'Corrigo', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'Learning Experience', 'Corrigo', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'Cheesecake Factory', 'Service Channel', 'Contact@seamlessfm.com', 'IVR', '(516) 500-7776'),
  ('SFM', 'Mobettah''s', 'Service Channel', 'Contact@seamlessfm.com', 'IVR', '(516) 500-7776'),
  ('SFM', 'Portland Leather', 'Seamgo', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'First Watch', 'Service Channel', 'Contact@seamlessfm.com', 'IVR', '(516) 500-7776'),
  ('SFM', 'Mimi''s Cafe', 'EcoTrack', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'Rural King', 'Service Channel', 'Contact@seamlessfm.com', 'IVR', '(516) 500-7776'),
  ('SFM', 'Uncommon Brands', 'EcoTrack', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'Wendy''s Corp', 'Corrigo', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'Din Tai Fung', 'Service Channel', 'Contact@seamlessfm.com', 'IVR', '(516) 500-7776'),
  ('SFM', 'Fedex', 'Service Channel', 'Contact@seamlessfm.com', 'IVR', '(516) 500-7776'),
  ('SFM', 'Habit Burger', 'Service Channel', 'Contact@seamlessfm.com', 'IVR', '(516) 500-7776'),
  ('SFM', 'KinderCare', 'Service Channel', 'Contact@seamlessfm.com', 'IVR', '(516) 500-7776'),
  ('SFM', 'Menards', 'Service Channel', 'Contact@seamlessfm.com', 'IVR', '(516) 500-7776'),
  ('SFM', 'Canteen', 'Email', 'Contact@seamlessfm.com', 'Email', ''),
  ('SFM', 'Swig Stores', 'EcoTrack', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'Basha''s', 'Corrigo', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'JRSK', 'Service Channel', 'Contact@seamlessfm.com', 'IVR', '(516) 500-7776'),
  ('SFM', 'Extra Space Storage', 'Email', 'Contact@seamlessfm.com', 'Email', ''),
  ('SFM', 'Sun Holdings', 'Email', 'Contact@seamlessfm.com', 'Email', 'Also on Seamgo'),
  ('SFM', 'RMH', 'Email', 'Contact@seamlessfm.com', 'Email', ''),
  ('SFM', 'AMP', 'Email', 'Contact@seamlessfm.com', 'Email', ''),
  ('SFM', 'Biscuit Ville', 'Corrigo', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'Net Lease', 'Email', 'Contact@seamlessfm.com', 'Email', ''),
  ('SFM', 'Car Mart', 'Corrigo', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'IRC', 'FEXA', 'Service@seamlessfm.com', 'IVR', ''),
  ('SFM', 'Sizzling Platter', 'EcoTrack', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'AMC', 'Corrigo', 'Contact@seamlessfm.com', 'Portal', ''),
  ('SFM', 'ONO BBQ', 'Email', 'Contact@seamlessfm.com', 'Email', ''),
  ('BKR', 'EMCOR', 'Corrigo', 'emcor@bkrnational.com', 'IVR', ''),
  ('BKR', 'Branded', 'Email', 'info@bkrnational.com', 'Email', ''),
  ('BKR', 'PH', 'Metryx', 'dispatchph@bkrnational.com', 'Portal', 'Picture + manager name'),
  ('AF', 'FreshCo', 'Email', 'support@alphafixers.com', 'Email', ''),
  ('AF', 'O''reilly', 'Service Channel', 'contact@alphafixers.com', 'IVR', '(516) 500-7776'),
  ('AF', 'AFS', 'Email', 'support@alphafixers.com', 'IVR', '(866) 254-8347'),
  ('AF', 'FSFS', 'Email', 'frontstreet@alphafixers.com', 'IVR', '(866) 254-8780'),
  ('AF', 'ResQ', 'ResQ', 'support@alphafixers.com', 'Portal', 'Picture + manager name'),
  ('AF', 'Impact', 'Email', 'support@alphafixers.com', 'Email', ''),
  ('AF', 'NEST', 'Nest', 'support@alphafixers.com', 'IVR', '(877) 374-2054'),
  ('AF', 'Ferrandino&Son', 'Email', 'support@alphafixers.com', 'Email', ''),
  ('AF', 'RMM', 'Email', 'support@alphafixers.com', 'Email', ''),
  ('AF', 'PH', 'Metryx', 'support@alphafixers.com', 'Portal', 'Picture + manager name'),
  ('AF', 'Outback Staekhouse', 'Service Channel', 'support@alphafixers.com', 'IVR', '(516) 500-7776'),
  ('AF', 'All Systems', 'Email', 'support@alphafixers.com', 'Email', ''),
  ('AF', 'Sheer', 'Email', 'support@alphafixers.com', 'Email', ''),
  ('TPM', 'Laser', 'Email', 'info@texaspipemasters.com', 'Email', ''),
  ('TPM', 'PRS', 'Service Channel', 'info@texaspipemasters.com', 'IVR', '(516) 500-7776'),
  ('TPM', 'Vixxo', 'Vixxo', 'info@texaspipemasters.com', 'IVR', '(888) 928-3276'),
  ('TPM', 'Truesource', 'Service Channel', 'info@texaspipemasters.com', 'IVR', '(516) 500-7776'),
  ('TPM', 'RSM LEO', 'Email', 'info@texaspipemasters.com', 'Email', ''),
  ('TPM', 'HERO', 'Email', 'info@texaspipemasters.com', 'Email', ''),
  ('TPM', 'ResQ', 'ResQ', 'info@texaspipemasters.com', 'Portal', 'Picture + manager name'),
  ('TPM', 'NEST', 'Nest', 'info@texaspipemasters.com', 'IVR', '(877) 374-2054'),
  ('TPM', 'Boss', 'Email', 'info@texaspipemasters.com', 'IVR', '(877) 841-0301'),
  ('TPM', 'AFS', 'Email', 'info@texaspipemasters.com', 'IVR', '(866) 254-8347'),
  ('TPM', '23rd Group', 'Email', 'info@texaspipemasters.com', 'Email', ''),
  ('TPM', 'SFS', 'Email', 'info@texaspipemasters.com', 'Email', ''),
  ('TPM', 'AAFM', 'AAFM', 'info@texaspipemasters.com', 'Portal', ''),
  ('TPM', 'DAVACO', 'Email', 'info@texaspipemasters.com', 'IVR', '(833) 948-2261'),
  ('TPM', 'KFM', 'Email', 'info@texaspipemasters.com', 'IVR', '(301) 854-6776'),
  ('TPM', 'PH', 'Metryx', 'info@texaspipemasters.com', 'Portal', 'Picture + manager name'),
  ('RF', 'Lessen', 'Lessen', 'info@repairfected.com', 'Portal', 'Picture'),
  ('RF', 'PH', 'Metryx', 'info@repairfected.com', 'Portal', 'Picture + manager name'),
  ('RF', 'FSFS', 'Email', 'info@repairfected.com', 'IVR', '(866) 254-8780');

-- The app spells the portal Ecotrak (CICO_PORTAL_SUGGESTIONS, the
-- integrations); everything else is kept as the sheet has it.
UPDATE cico_sheet SET portal = 'Ecotrak' WHERE lower(btrim(portal)) IN ('ecotrack', 'ecotrak');

INSERT INTO client (name)
SELECT DISTINCT ON (lower(btrim(s.client))) btrim(s.client)
  FROM cico_sheet s
 WHERE NOT EXISTS (SELECT 1 FROM client c WHERE c.deleted_at IS NULL AND lower(btrim(c.name)) = lower(btrim(s.client)))
 ORDER BY lower(btrim(s.client))
ON CONFLICT DO NOTHING;

INSERT INTO client_cico_method (client_id, billing_entity, method, portal, detail, email)
SELECT c.id,
       upper(btrim(s.comp)),
       btrim(s.method),
       CASE WHEN btrim(s.method) = 'Portal' THEN NULLIF(btrim(s.portal), '') END,
       NULLIF(concat_ws(' · ',
         CASE WHEN btrim(s.method) <> 'Portal'
                   AND lower(btrim(s.portal)) NOT IN ('', 'email', lower(btrim(s.method)))
              THEN btrim(s.portal) END,
         NULLIF(btrim(s.notes), '')), ''),
       NULLIF(lower(btrim(s.email)), '')
  FROM cico_sheet s
  JOIN LATERAL (
    SELECT id FROM client c
     WHERE c.deleted_at IS NULL AND lower(btrim(c.name)) = lower(btrim(s.client))
     ORDER BY c.created_at LIMIT 1
  ) c ON true
ON CONFLICT DO NOTHING;
