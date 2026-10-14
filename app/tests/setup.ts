// Hermetic test environment (W6-4). Runs before every test file (vitest
// `setupFiles`); config.ts skips app/.env under VITEST, so these are the ONLY
// variables the suite sees — on a developer's machine and on a CI runner
// with no .env alike.
process.env.NODE_ENV = 'test';
process.env.AUTH_DEV_BYPASS = 'true';
process.env.WEB_ORIGIN = 'http://127.0.0.1:5173';
process.env.DATABASE_URL = 'postgres://localhost:5432/theone_test'; // never opened — getPool() is lazy and no test may call it
delete process.env.DEMO_MODE;
// A shell that exports the Entra registration would otherwise flip config.ts
// into entra mode (complete Entra credentials win over the bypass flag).
for (const k of ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET']) delete process.env[k];
