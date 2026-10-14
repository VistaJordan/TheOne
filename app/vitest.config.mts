import { defineConfig } from 'vitest/config';

// Phase 0 test harness. Scoped to tests/ on purpose: the repo has no co-located
// specs yet, and an unscoped glob would try to collect node_modules.
//
// tests/setup.ts runs before every test file and makes the suite hermetic
// (W6-4): it sets the auth / origin / database variables itself, and config.ts
// skips app/.env under vitest — so a CI runner with no .env and a developer's
// shell get the same run. Nothing opens a database: getPool() is lazy and no
// test may call it.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // The API service modules are large; importing them dominates a file's
    // time, not the tests themselves.
    testTimeout: 30_000,
  },
});
