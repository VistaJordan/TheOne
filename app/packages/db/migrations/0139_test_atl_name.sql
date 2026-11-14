-- 0139 · Elise, 2026-11-14.
--
-- 0135 renamed the `atl` role to Associate Team Lead, but a test account's
-- display name is written once, when it is first created ("Test " + the role
-- label at that moment), and later sign-ins never touch it. So the ATL test
-- account still read "Test Assistant TL". Rename it, only while it still
-- holds the old name (a name an admin chose since is left alone). The
-- address is the marker (`test+<code>@test.theone.local`); no seed twin, the
-- seed never creates test accounts.

UPDATE principal
   SET display_name = 'Test Associate Team Lead'
 WHERE lower(email) = 'test+atl@test.theone.local'
   AND display_name IN ('Test Assistant TL', 'Test Assistant Team Lead');
