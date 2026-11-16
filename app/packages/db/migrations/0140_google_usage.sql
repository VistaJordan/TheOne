-- 0140 · Google Maps use, counted (Elise, 2026-11-15).
--
-- The Address box now offers Google's addresses as it is typed (Add work
-- order, a draft, the work order's own Address field). Google bills that by
-- use, so every request we make is counted here: one row per Chicago day and
-- kind, bumped as the request is made. Admin › Integrations › Google Maps
-- reads it (today, this month, last month), and the daily cap on suggestion
-- requests is asked of it before Google is.
--
--   autocomplete   a suggestions request (several per address typed)
--   place_details  an address picked from the list (the billed end of a session)
--   geocode        an address placed on the map for ClickUp (0132)
--
-- Counters only: no person, no address, no FK. The seed does not truncate it.

CREATE TABLE IF NOT EXISTS google_usage (
  day   date    NOT NULL,
  kind  text    NOT NULL CHECK (kind IN ('autocomplete', 'place_details', 'geocode')),
  uses  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);
