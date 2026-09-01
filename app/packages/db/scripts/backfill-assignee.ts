// One-off: add the "Assignee" custom field and fill it from the ClickUp export
// WITHOUT re-seeding — so saved views, sessions and local edits survive.
//
// The seed does the same thing on a fresh database (see seed.ts, ASSIGNEE_FIELD);
// this is for a database that was seeded before Assignee existed. Idempotent:
// a second run adds nothing.
//
//   npx tsx packages/db/scripts/backfill-assignee.ts     (from app/)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePool, query } from '../src/client';

interface ClickupTask { id: string; assignees?: string[] }
interface ClickupData { taskSamples: ClickupTask[] }

const FIELD = 'Assignee';
const data: ClickupData = JSON.parse(
  readFileSync(fileURLToPath(new URL('../seed/clickup-data.json', import.meta.url)), 'utf8'),
);

const def = await query(`SELECT 1 FROM field_def WHERE key = $1 LIMIT 1`, [FIELD]);
if (def.rows.length === 0) {
  const c = await query<{ container_id: string }>(
    `SELECT container_id FROM field_def ORDER BY position NULLS LAST LIMIT 1`,
  );
  const containerId = c.rows[0]?.container_id;
  if (!containerId) throw new Error('No field_def rows — is the database seeded?');
  await query(
    `INSERT INTO field_def (container_id, key, label, type, type_config, position)
     VALUES ($1, $2, $2, 'users', '{}'::jsonb, 0)`,
    [containerId, FIELD],
  );
  console.log(`field_def "${FIELD}" created`);
} else {
  console.log(`field_def "${FIELD}" already present`);
}

let updated = 0;
let skipped = 0;
for (const t of data.taskSamples) {
  if (!t.assignees?.length) continue;
  const r = await query(
    `UPDATE task
        SET fields = fields || jsonb_build_object($1::text, $2::text)
      WHERE wo_number = $3 AND (fields->>$1) IS NULL`,
    [FIELD, t.assignees.join(', '), t.id],
  );
  if (r.rowCount) updated += r.rowCount;
  else skipped++;
}
console.log(`tasks updated : ${updated}`);
console.log(`tasks skipped : ${skipped} (already had an ${FIELD}, or not in this database)`);

await closePool();
