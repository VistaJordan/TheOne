-- UAT follow-up T1 — test sign-in accounts (docs/specs/uat-round-1.md).
--
-- A test-account session is bound to the test password it was issued under:
-- the session row keeps a 16-hex fingerprint of it (lib/testAccountAuth.ts
-- testPasswordFingerprint), and loadSession (services/auth.ts) treats a test
-- account's session as signed out when the feature is off or the fingerprint
-- no longer matches TEST_ACCOUNTS_PASSWORD — so switching the feature off or
-- rotating the password ends every test session at once. NULL for every
-- other session. No data: nothing for seed.ts to keep in step.

ALTER TABLE session ADD COLUMN IF NOT EXISTS test_password_fp text;
