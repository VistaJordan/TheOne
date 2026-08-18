import { defineConfig } from 'vitest/config';

// Phase 0 test harness. Scoped to tests/ on purpose: the repo has no co-located
// specs yet, and an unscoped glob would try to collect node_modules and the
// PGlite WASM fixtures.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // apps/api/src/services/quotes.ts transitively imports @electric-sql/pglite,
    // whose WASM load dominates startup (~7s). Nothing here opens a database —
    // getDb() is lazy — but the import itself is slow.
    testTimeout: 30_000,
  },
});
