/* W3-3 (AUDIT.md Must-fix, fix group G4a) — whole-bag writes lock the row.
 *
 * `task.fields` is one jsonb bag of ~100 keys. Reading it on the pool,
 * merging in JS and writing the whole bag back inside a later transaction
 * loses whatever another connection wrote in between — the database is
 * pooled Postgres, not a single-connection PGlite, and `withTransaction`
 * checks out one client while every other `query()` runs elsewhere. So every
 * whole-bag write in these services must read `fields … FOR NO KEY UPDATE`
 * on the SAME transaction that writes it, merge over that locked read, and
 * the "PGlite is single-connection" ordering comments must be gone.
 *
 * The lock-order half (loop 2): a child row whose task_id REFERENCES task(id)
 * takes a KEY SHARE on the task row when it is INSERTed. KEY SHARE conflicts
 * with FOR UPDATE alone, and a transaction upgrading its own lock waits for
 * every other holder — so two transactions that each INSERT a child and THEN
 * take FOR UPDATE wait on each other, and Postgres aborts one (40P01). Every
 * transaction that ends in a bag write must lock the task row FIRST.
 *
 * The lock-strength half (F3, the follow-up batch): every task-row lock in
 * the six bag writers is FOR NO KEY UPDATE, never plain FOR UPDATE. No bag
 * write sets task.id or task.wo_number (the unique-indexed columns), so NO
 * KEY UPDATE serialises bag writers among themselves exactly as FOR UPDATE
 * did, while a child INSERT's KEY SHARE no longer waits behind a bag write
 * and the upgrade deadlock above cannot start. The reason is written once,
 * in woFieldValues.ts; the parent-first order stays as belt and braces. Out
 * of scope on purpose: purchasing.ts (RFQ / purchase-order rows), users.ts
 * (the principal ring) and the Ecotrak ingest keep their own FOR UPDATE.
 *
 * The premise is pinned too (loop 3): the unique-indexed columns of task are
 * read off the migrations (the CREATE TABLE and every later UNIQUE index or
 * constraint) and must be exactly id + wo_number, and neither the lists a
 * bag writer SETs promoted columns from (MIRROR_BY_JSON_KEY, BULK_COLUMNS,
 * IMPORTABLE) nor any literal UPDATE task SET clause in the six files may
 * name one — a UNIQUE added to a promoted column would turn that bag write
 * back into a FOR UPDATE and reopen the upgrade wait. The comment stripper
 * strips comments, not lines, so a wrapped SQL line starting with `*` is swept.
 *
 * Source-text assertions: the house pattern for "is the lock present"
 * (tests/docs.test.ts reads AppShell.tsx the same way). Hermetic — nothing
 * from the API is imported, no database, no network.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(file: string): string {
  return readFileSync(new URL(`../apps/api/src/services/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

/** The text of ONE top-level function: from `[export ]async function name(`
    to the first closing brace at column 0 after it. */
function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`^(?:export )?async function ${name}[(]`, 'm'));
  if (start < 0) throw new Error(`${name}( not found`);
  const end = src.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`end of ${name}( not found`);
  // A `}` at column 0 can only be the function's own: whatever follows must
  // sit at column 0 again, or the slice stopped short and the assertions
  // would be reading half a function.
  const next = src.slice(end + 3).split('\n').find((l) => l.trim() !== '');
  if (next !== undefined && /^\s/.test(next)) throw new Error(`${name}( body cut short before "${next.trim()}"`);
  return src.slice(start, end + 3);
}

/** The text of a function's ONE withTransaction callback. */
function txBlock(body: string): string {
  const start = body.indexOf('withTransaction(');
  if (start < 0) throw new Error('withTransaction( not found');
  const end = body.indexOf('\n  })', start);
  if (end < 0) throw new Error('end of withTransaction( not found');
  return body.slice(start, end);
}

/** The locked read of the bag: one row, by id, FOR NO KEY UPDATE. */
const LOCKED_READ = /SELECT fields FROM task WHERE id = \$1(?: AND deleted_at IS NULL)? FOR NO KEY UPDATE/;
/** The whole-bag write (woFieldValues builds its SET list, so no `fields =` literal). */
const BAG_WRITE = /UPDATE task SET /;
/** Any lock on the task row by id: the locked bag read, or the bare
    `SELECT 1 … FOR NO KEY UPDATE` a transaction takes before it touches a child. */
const TASK_LOCK = /FROM task WHERE id = \$1(?: AND deleted_at IS NULL)? FOR NO KEY UPDATE/;
/** A plain FOR UPDATE: the strength no task-row lock in the bag writers may take any more (F3). */
const PLAIN_FOR_UPDATE = /(?<!NO KEY )\bFOR UPDATE\b/;

const WRITERS: Record<string, string[]> = {
  'woFieldValues.ts': ['updateWorkOrderFields'],
  'visits.ts': ['syncMirrors'],
  'signoff.ts': ['generate', 'fileSignedCopy'],
  'assigneeHistory.ts': ['recordPreviousAssignees'],
  'moneySync.ts': ['writeField'],
};

/** The six services that write task.fields: every task-row lock they take is swept below. */
const BAG_WRITER_FILES = ['woFieldValues.ts', 'woBulk.ts', 'visits.ts', 'signoff.ts', 'assigneeHistory.ts', 'moneySync.ts'];

/** The code of a file with its comments taken out, as lines, so a lock clause
    named in prose (the note in woFieldValues.ts quotes both strengths) is not
    read as SQL. Comments are STRIPPED, not lines dropped: a continuation line
    of a multi-line SQL template may itself start with `*` (a wrapped
    `SELECT *`) and must still be swept. A `//` counts only at the start of a
    line or after whitespace, so a `https://…` inside a string survives. */
function codeLines(src: string): string[] {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
    .split('\n');
}

describe('whole-bag writes read task.fields FOR NO KEY UPDATE on the transaction that writes it (W3-3)', () => {
  for (const [file, fns] of Object.entries(WRITERS)) {
    const src = source(file);
    for (const name of fns) {
      it(`${file} · ${name}: the locked read comes before the bag write`, () => {
        const body = fnBody(src, name);
        const lockAt = body.search(LOCKED_READ);
        const writeAt = body.search(BAG_WRITE);
        expect(lockAt, `${name} has no FOR NO KEY UPDATE read of task.fields`).toBeGreaterThanOrEqual(0);
        expect(writeAt, `${name} has no whole-bag UPDATE`).toBeGreaterThanOrEqual(0);
        expect(lockAt).toBeLessThan(writeAt);
      });
    }
    it(`${file}: no comment claims single-connection ordering any more`, () => {
      expect(src).not.toContain('PGlite');
      expect(src).not.toMatch(/single-connection|one connection|self-deadlock/i);
    });
  }
});

describe('updateWorkOrderFields (woFieldValues.ts)', () => {
  const src = source('woFieldValues.ts');
  const body = fnBody(src, 'updateWorkOrderFields');

  it('reads the bag only once, locked, inside withTransaction — never t.fields on the pool', () => {
    expect(src).not.toContain('t.fields FROM task');
    const reads = body.match(/SELECT[^`]*\bfields\b[^`]*FROM task[^`]*/g) ?? [];
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/FOR NO KEY UPDATE/);
    expect(body.indexOf('withTransaction(')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('withTransaction(')).toBeLessThan(body.search(LOCKED_READ));
  });

  it('runs the rule-11.1.1 gate on the transaction, against the merged bag', () => {
    expect(body).toMatch(/awaitingAcceptance\(tx, /);
    expect(body).toMatch(/assertReadyToAssign\(tx, [^,]+, merged\)/);
    expect(body).not.toContain('{ query }');
  });

  it('still logs on the transaction and dispatches automations after the commit', () => {
    const txStart = body.indexOf('withTransaction(');
    const txEnd = body.indexOf('\n  });', txStart);
    expect(txEnd).toBeGreaterThan(txStart);
    const logAt = body.indexOf('logTaskChanges(tx, ');
    expect(logAt).toBeGreaterThan(txStart);
    expect(logAt).toBeLessThan(txEnd);
    expect(body.indexOf('dispatchAutomations(')).toBeGreaterThan(txEnd);
  });
});

describe('syncMirrors (visits.ts)', () => {
  const src = source('visits.ts');

  it('is only ever called on the transaction, so its FOR NO KEY UPDATE read holds until the commit', () => {
    const calls = [...src.matchAll(/syncMirrors\((\w+), /g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(3); // create, update, delete
    for (const q of calls) expect(q).toBe('tx');
  });
});

describe('sign-off writes (signoff.ts)', () => {
  const src = source('signoff.ts');

  for (const name of ['generate', 'fileSignedCopy']) {
    it(`${name} merges over the locked bag, not over the pool read`, () => {
      const body = fnBody(src, name);
      expect(body).not.toContain('...f.fields');
      expect(body).toMatch(/\.\.\.bag, \[K_LINK\]: link/);
    });
  }
});

describe('recordPreviousAssignees (assigneeHistory.ts)', () => {
  const src = source('assigneeHistory.ts');
  const body = fnBody(src, 'recordPreviousAssignees');

  it('reads the bag inside the transaction, locked, and writes nothing when nothing changed', () => {
    const txStart = body.indexOf('withTransaction(');
    expect(txStart).toBeGreaterThanOrEqual(0);
    expect(body.search(LOCKED_READ)).toBeGreaterThan(txStart);
    // No bag read outside the transaction.
    expect(body.slice(0, txStart)).not.toMatch(/FROM task/);
  });
});

describe('lock order: the task row is locked before any child row references it (W3-3, loop 2)', () => {
  it('visits.ts · createVisit locks the task row before INSERT INTO wo_visit', () => {
    const tx = txBlock(fnBody(source('visits.ts'), 'createVisit'));
    const lockAt = tx.search(TASK_LOCK);
    const insertAt = tx.indexOf('INSERT INTO wo_visit');
    expect(lockAt, 'createVisit takes no lock on the task row before the INSERT').toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(insertAt);
  });

  it('signoff.ts · generate locks the task row before it touches wo_signoff', () => {
    const tx = txBlock(fnBody(source('signoff.ts'), 'generate'));
    const lockAt = tx.search(TASK_LOCK);
    const updateAt = tx.indexOf('UPDATE wo_signoff');
    const insertAt = tx.indexOf('INSERT INTO wo_signoff');
    expect(lockAt, 'generate takes no lock on the task row').toBeGreaterThanOrEqual(0);
    expect(updateAt).toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(updateAt);
    expect(lockAt).toBeLessThan(insertAt);
  });

  it('signoff.ts · fileSignedCopy takes the same order (task row, then the sheet row)', () => {
    const tx = txBlock(fnBody(source('signoff.ts'), 'fileSignedCopy'));
    const lockAt = tx.search(TASK_LOCK);
    const updateAt = tx.indexOf('UPDATE wo_signoff');
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(updateAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(updateAt);
  });

  it('signoff.ts · generate takes the orphaned blank out of the store when its transaction fails', () => {
    const body = fnBody(source('signoff.ts'), 'generate');
    const txEnd = body.indexOf('\n  })');
    expect(txEnd).toBeGreaterThanOrEqual(0);
    expect(body.slice(txEnd)).toMatch(/catch[\s\S]*del\(blob\.pathname, \{ token \}\)[\s\S]*throw err/);
  });
});

describe('lock strength: every task-row lock in the bag writers is FOR NO KEY UPDATE, never plain FOR UPDATE (F3)', () => {
  for (const file of BAG_WRITER_FILES) {
    it(`${file}: no plain FOR UPDATE is left on a code line, and every NO KEY lock is on the task row`, () => {
      const lines = codeLines(source(file));
      const plain = lines.filter((l) => PLAIN_FOR_UPDATE.test(l));
      expect(plain, `${file} still locks FOR UPDATE:\n${plain.join('\n')}`).toEqual([]);
      const locks = lines.filter((l) => /\bFOR NO KEY UPDATE\b/.test(l));
      expect(locks.length, `${file} takes no FOR NO KEY UPDATE lock`).toBeGreaterThan(0);
      for (const l of locks) expect(l).toMatch(/\bFROM task\b/);
    });
  }

  it('the reason is written once, in updateWorkOrderFields, and the other five point at it', () => {
    const body = fnBody(source('woFieldValues.ts'), 'updateWorkOrderFields');
    expect(body).toMatch(/FOR NO KEY UPDATE, not FOR UPDATE/);
    expect(body).toMatch(/task\.wo_number/);
    expect(body).toMatch(/KEY SHARE/);
    for (const file of BAG_WRITER_FILES.filter((f) => f !== 'woFieldValues.ts')) {
      expect(source(file), `${file} does not point at the note in woFieldValues.ts`).toContain('woFieldValues.ts');
    }
  });
});

describe('codeLines strips comments instead of dropping lines, so the sweep reaches a wrapped SQL line that starts with *', () => {
  it('keeps a template continuation line that starts with *, drops // and /* */ prose, keeps a // inside a URL', () => {
    const sample = [
      'const q = `SELECT',
      ' * FROM task FOR UPDATE`;',
      '// FOR UPDATE named in prose',
      '/* FOR UPDATE in a block',
      ' * that spans lines */',
      'run(); // FOR UPDATE after code',
      "const u = 'https://example.test/FOR'; // trailing",
    ].join('\n');
    const lines = codeLines(sample);
    expect(lines.filter((l) => PLAIN_FOR_UPDATE.test(l))).toEqual([' * FROM task FOR UPDATE`;']);
    expect(lines.join('\n')).toContain("'https://example.test/FOR'");
    expect(lines.join('\n')).not.toMatch(/prose|block|spans|after code|trailing/);
  });
});

describe('the premise of FOR NO KEY UPDATE: id and wo_number are the only unique-indexed columns of task, and no bag-writer SET names them (F3)', () => {
  const migrationsDir = new URL('../packages/db/migrations/', import.meta.url);
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({
      file,
      // SQL comments dropped first: 0041 says "task.wo_number, NOT NULL UNIQUE" in prose.
      sql: readFileSync(new URL(file, migrationsDir), 'utf8').replace(/\r\n/g, '\n').replace(/--.*$/gm, ''),
    }));

  /** The columns of task that carry a unique index: read off the CREATE TABLE
      in 0001, with every later migration checked for a UNIQUE index or
      constraint on task (there is none today — one would be a new premise). */
  function uniqueColumnsOfTask(): string[] {
    const init = migrations.find((m) => m.file === '0001_init.sql');
    if (!init) throw new Error('0001_init.sql not found');
    const start = init.sql.search(/^CREATE TABLE (?:IF NOT EXISTS )?task\s*\(/m);
    if (start < 0) throw new Error('CREATE TABLE task not found');
    const block = init.sql.slice(start, init.sql.indexOf('\n);', start));
    const cols: string[] = [];
    for (const line of block.split('\n').slice(1)) {
      const m = line.match(/^\s*(\w+)\s+\w[^,]*\b(?:PRIMARY KEY|UNIQUE)\b/);
      if (m) cols.push(m[1]);
      if (/^\s*(?:UNIQUE|PRIMARY KEY)\s*\(/.test(line)) throw new Error(`table-level constraint on task: ${line.trim()}`);
    }
    for (const { file, sql } of migrations) {
      for (const stmt of sql.match(/CREATE UNIQUE INDEX[^;]*;/gi) ?? []) {
        if (/\bON\s+task\s*\(/i.test(stmt)) throw new Error(`${file}: ${stmt.trim()}`);
      }
      for (const stmt of sql.match(/ALTER TABLE (?:IF EXISTS )?task\b[^;]*;/gi) ?? []) {
        if (/\b(?:UNIQUE|PRIMARY KEY)\b/i.test(stmt)) throw new Error(`${file}: ${stmt.trim()}`);
      }
    }
    return cols;
  }

  const uniqueCols = uniqueColumnsOfTask();

  it('reads the unique-indexed columns of task off the migrations: exactly id and wo_number', () => {
    expect(migrations.length).toBeGreaterThan(80);
    expect(uniqueCols).toEqual(['id', 'wo_number']);
  });

  it('woMirrors.ts · MIRROR_BY_JSON_KEY promotes no unique-indexed column', () => {
    const cols = [...source('woMirrors.ts').matchAll(/column: '(\w+)'/g)].map((m) => m[1]);
    expect(cols.length).toBeGreaterThanOrEqual(8);
    expect(cols.filter((c) => uniqueCols.includes(c))).toEqual([]);
  });

  it('woBulk.ts · BULK_COLUMNS and IMPORTABLE name no unique-indexed column', () => {
    const src = source('woBulk.ts');
    const bulkAt = src.indexOf('const BULK_COLUMNS = {');
    expect(bulkAt).toBeGreaterThan(-1);
    const bulkCols = [...src.slice(bulkAt, src.indexOf('} as const;', bulkAt)).matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(bulkCols.length).toBeGreaterThanOrEqual(8);
    expect(bulkCols.filter((c) => uniqueCols.includes(c))).toEqual([]);
    const importAt = src.indexOf('const IMPORTABLE = new Set([');
    expect(importAt).toBeGreaterThan(-1);
    const importable = [...src.slice(importAt, src.indexOf(']);', importAt)).matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(importable.length).toBeGreaterThanOrEqual(11);
    expect(importable.filter((c) => uniqueCols.includes(c))).toEqual([]);
  });

  for (const file of BAG_WRITER_FILES) {
    it(`${file}: no literal UPDATE task SET clause names a unique-indexed column`, () => {
      const code = codeLines(source(file)).join('\n');
      const sets = [...code.matchAll(/UPDATE task SET([\s\S]*?)WHERE/g)].map((m) => m[1]);
      expect(sets.length, `${file} has no UPDATE task SET`).toBeGreaterThan(0);
      for (const set of sets) {
        for (const col of uniqueCols) {
          expect(set, `${file} SETs ${col} under a NO KEY lock:${set}`).not.toMatch(new RegExp(`\\b${col}\\s*=`));
        }
      }
    });
  }
});
