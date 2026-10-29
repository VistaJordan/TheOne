-- 0110 · Prices: OP Admin, ATL, TL and AM keep the list (Elise, 2026-10-29).
--
-- 0101 gave the admin role all four actions on `prices` and every role that
-- views quotes view only. Now Operations Admin (oa), Assistant Team Lead
-- (atl), Team Lead (tl) and Account Manager (am) may also add a card (New
-- price card, create) and change one (Edit, edit); admin is asserted again so
-- a Roles-screen edit that took it away is undone too. Remove (delete) stays
-- the admin role's alone. The Prices page and the API read the grants
-- (`d.can`, routes/prices.ts), so nothing else changes.
--
-- Roles are not truncated by the seed, so there is no seed twin; Admin › Roles
-- or a per-person Adjust can change any of it. The same session-only merge as
-- 0108: an action this file does not name keeps what it was.

CREATE FUNCTION pg_temp.p110_grant(p_code text, p_path text, p_grant jsonb) RETURNS void AS $$
  UPDATE role
     SET permissions = COALESCE(permissions, '{}'::jsonb)
                       || jsonb_build_object(p_path, COALESCE(permissions -> p_path, '{}'::jsonb) || p_grant)
   WHERE code = p_code;
$$ LANGUAGE sql;

SELECT pg_temp.p110_grant(r.code, 'prices', '{"view": true, "create": true, "edit": true}')
  FROM unnest(ARRAY['oa', 'atl', 'tl', 'am', 'admin']) AS r(code);
