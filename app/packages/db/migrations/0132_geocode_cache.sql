-- 0132 · Addresses placed on the map, once each (Elise, 2026-11-10).
--
-- ClickUp's "17. Address" is a map location field: it takes coordinates plus
-- the written address. The ClickUp sync asks Google's geocoder for an
-- address the first time it sends it and keeps the answer here, so the same
-- address is never looked up twice. When Google cannot place it, the centre
-- of its ZIP (geo_zip, 0056) stands in; an address neither can place is
-- remembered as such and asked again after 30 days.
--
-- Configuration-like, no FK: the seed does not truncate it.

CREATE TABLE geocode_cache (
  address_key  text PRIMARY KEY,          -- the address lower-cased, spaces collapsed
  address      text NOT NULL,             -- as it was first sent
  lat          double precision,
  lng          double precision,
  source       text NOT NULL CHECK (source IN ('google', 'zip', 'none')),
  looked_up_at timestamptz NOT NULL DEFAULT now()
);
