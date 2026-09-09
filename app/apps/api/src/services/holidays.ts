// The System_Holiday_Table of rule 2.3.2 (migration 0024): the days, besides
// Saturdays and Sundays, on which the quote clock pauses. Edited in Admin ›
// Settings; read by the visit service every time it derives a Quote Due Date.
//
// Configuration, not data: no foreign keys and the seed leaves the table
// alone, so the list survives a re-seed like the automations do.

import type { Holiday } from '@theone/shared';
import { query } from '../db.js';
import { ApiError } from '../errors.js';

interface Row {
  day: string;
  name: string;
}

/** Whatever client we are handed — the pool or a transaction. */
interface Q {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const SELECT = `SELECT to_char(day, 'YYYY-MM-DD') AS day, name FROM holiday`;

export async function listHolidays(q: Q = { query }): Promise<Holiday[]> {
  const res = await q.query<Row>(`${SELECT} ORDER BY day`);
  return res.rows;
}

/** Just the days, for the clock arithmetic. */
export async function holidayDays(q: Q = { query }): Promise<string[]> {
  const res = await q.query<{ day: string }>(`SELECT to_char(day, 'YYYY-MM-DD') AS day FROM holiday`);
  return res.rows.map((r) => r.day);
}

function assertDay(day: string): string {
  const s = day.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new ApiError('BAD_REQUEST', 'A holiday needs a date (YYYY-MM-DD)');
  }
  return s;
}

/** Add a holiday, or rename the one already on that day. */
export async function setHoliday(day: string, name: string): Promise<Holiday> {
  const d = assertDay(day);
  const n = name.trim();
  if (!n) throw new ApiError('BAD_REQUEST', 'A holiday needs a name');
  const res = await query<Row>(
    `INSERT INTO holiday (day, name) VALUES ($1::date, $2)
     ON CONFLICT (day) DO UPDATE SET name = EXCLUDED.name
     RETURNING to_char(day, 'YYYY-MM-DD') AS day, name`,
    [d, n],
  );
  return res.rows[0];
}

export async function deleteHoliday(day: string): Promise<Holiday | null> {
  const d = assertDay(day);
  const res = await query<Row>(
    `DELETE FROM holiday WHERE day = $1::date RETURNING to_char(day, 'YYYY-MM-DD') AS day, name`,
    [d],
  );
  return res.rows[0] ?? null;
}
