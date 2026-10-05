-- 0069 · Suggested vendors: the top few vendors for a work order, by its
-- trade, its location and its client.
--
-- Two layers make the list (packages/shared/src/vendorSuggest.ts):
--   1. the PREFERRED VENDOR rules of 0057, hand-picked, most specific first;
--   2. an automatic fill for the slots left over: vendors of the work order's
--      trade that cover its location, sorted by a fixed order of tie-breakers
--      (worked for this client before, distance, paperwork, jobs done, rate).
--
-- Everything that decides the list is configuration in Admin › Vendors & map
-- (one vendor_setting row, `suggest`): the size of the list, whether the
-- automatic fill runs at all, the order of the tie-breakers and which are
-- off, the hard filters, and whether the dispatch cascade of 0066 may offer a
-- job to an automatically chosen vendor (OFF: it keeps to hand-picked ones).
-- A blacklisted vendor is never suggested; that one is not a setting.
--
-- Additive. A rule may now name a CITY inside its state, which outranks a
-- state-only rule for the same client and trade; every rule on file has no
-- city and matches exactly as before.

ALTER TABLE preferred_vendor
  ADD COLUMN city text,
  -- a city alone is ambiguous (Springfield): it is always a city of a state
  ADD CONSTRAINT preferred_vendor_city_needs_state CHECK (city IS NULL OR state IS NOT NULL);

INSERT INTO vendor_setting (key, value) VALUES
  ('suggest', '{
     "size": 5,
     "auto_fill": true,
     "order": ["client_history", "distance", "compliance", "jobs", "rate"],
     "off": [],
     "match_trade": true,
     "in_coverage": true,
     "require_compliance": false,
     "emergency_availability": false,
     "cascade_auto": false
   }'::jsonb)
ON CONFLICT (key) DO NOTHING;
