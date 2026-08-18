// Runnable self-checks for the business-time module (S5).
//
//   npx tsx apps/api/src/lib/businessTime.selftest.ts
//
// Touches NO database — safe to run while the API process holds pgdata.
// Exits 1 on the first failing assertion so it can gate a build later.

import { runSelfChecks } from './businessTime.js';

const checks = runSelfChecks();
const failed = checks.filter((c) => !c.ok);

for (const c of checks) {
  if (c.ok) {
    console.log(`  ok   ${c.name}`);
  } else {
    console.log(`  FAIL ${c.name}`);
    console.log(`         expected: ${c.expected}`);
    console.log(`         actual:   ${c.actual}`);
  }
}

console.log(`\nbusinessTime: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
