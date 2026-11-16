/*
 * 0119 · The NTE follows Ecotrak (Elise, 2026-11-03).
 *
 * One NTE: the Client NTE field, which `task.nte` mirrors. The sync writes the
 * field and the mirror together. Since 2026-11-16 it does so whenever
 * Ecotrak's figure differs from ours: nothing else may write the NTE of a
 * linked work order while the sync is on (tests/nte-sync-only.test.ts).
 * Source pins: the ingest opens a database, the suite does not.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = resolve(__dirname, '..');
const ingest = readFileSync(join(APP, 'apps', 'api', 'src', 'modules', 'integrations', 'ecotrak', 'ingest.ts'), 'utf8');
const migration = readFileSync(join(APP, 'packages', 'db', 'migrations', '0119_ecotrak_nte.sql'), 'utf8');

describe('0119 · the NTE follows Ecotrak', () => {
  it('remembers what Ecotrak last sent', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS ecotrak_nte numeric/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS ecotrak_nte_seen_at timestamptz/);
  });

  it('never writes the NTE column alone on a refresh', () => {
    const refreshes = ingest.match(/UPDATE task SET title=\$2[\s\S]*?WHERE id=\$1/g) ?? [];
    expect(refreshes).toHaveLength(2);
    for (const sql of refreshes) expect(sql).not.toMatch(/\bnte\s*=/);
  });

  it('writes the field and its mirror together', () => {
    expect(ingest).toMatch(/jsonb_build_object\(\$2::text, \$3::numeric\),\s*nte = \$3::numeric/);
  });

  it("puts Ecotrak's figure in whenever ours differs (2026-11-16: the NTE is the sync's alone)", () => {
    expect(ingest).not.toMatch(/nteSeen/);
    expect(ingest).toMatch(/if \(ecoNte !== null\) \{\s*const ours = bagBefore\[K_NTE\] \?\? before\.nte \?\? null;\s*if \(!same\(ours, ecoNte, true\)\)/);
    // an unchanged payload is still re-read while our NTE drifted from Ecotrak's
    expect(ingest).toMatch(/prior\?\.last_payload_hash === hash && nteAligned/);
    // a blank on Ecotrak never forgets the last figure
    expect(ingest).toMatch(/ecotrak_nte = COALESCE\(\$5::numeric, ecotrak_nte\)/);
  });

  it('is audited as Ecotrak and dispatched to the automations', () => {
    expect(ingest).toMatch(/field: `fields\.\$\{K_NTE\}`/);
    expect(ingest).toMatch(/dispatchAutomations\(\{ taskId: n\.taskId, kind: 'changed', changes: \[n\.change\] \}\)/);
  });
});
