// City, State and Zip Code follow the address (packages/shared/src/addressParts.ts).
//
// Every writer of a work order's bag calls `fillFromAddress` when the save
// sets `17. Address` to something non-blank: the field editor and the
// automations (woFieldValues), bulk edit and the CSV import (woBulk), Add work
// order (woCreate), an intake draft's Submit (intake), a planned-maintenance
// raise and the Ecotrak sync. The three parts are read off the text; a part
// the text does not carry is completed from the ZIP table (geo_zip, our own
// database — nothing leaves the app). Rules (Elise, 2026-10-22):
//   - the parts overwrite what the three fields held: the address is the
//     source, and a hand edit stays until the address changes again;
//   - a value the SAME save sets explicitly wins (that is the hand edit);
//   - an address that names none of them changes nothing;
//   - going forward only: nothing back-fills the work orders on file.
// The caller logs the returned changes `via: 'address'` and keeps the City /
// State mirror columns in step.

import { ADDRESS_KEY, addressPartValues, parseAddressParts, type AddressPartKey } from '@theone/shared';
import { query, type Queryable } from '../db.js';

/** The pool, for a writer that is not inside a transaction yet. */
const POOL: Queryable = { query };

export interface AddressFillChange {
  key: AddressPartKey;
  before: unknown;
  after: string;
}

/** The city and state a ZIP names in our own table (geo_zip, 0056), for the
    forms to complete an address that carries only the ZIP. Null when the
    ZIP is unknown. */
export async function zipPlace(zip: string): Promise<{ city: string; state: string } | null> {
  const five = zip.trim().slice(0, 5);
  if (!/^\d{5}$/.test(five)) return null;
  const res = await query<{ city: string; state: string }>(`SELECT city, state FROM geo_zip WHERE zip = $1`, [five]);
  return res.rows[0] ?? null;
}

/** Did this save put a non-blank address on the work order? */
export function addressWritten(before: unknown, after: unknown): boolean {
  if (typeof after !== 'string' || after.trim() === '') return false;
  return String(before ?? '') !== after;
}

/** The parts of `address`, a missing city / state completed from the ZIP. */
export async function addressPartsFor(
  address: unknown,
  q: Queryable = POOL,
): Promise<Partial<Record<AddressPartKey, string>>> {
  const parts = parseAddressParts(address);
  if (parts.zip && (!parts.city || !parts.state)) {
    try {
      const res = await q.query<{ city: string; state: string }>(
        `SELECT city, state FROM geo_zip WHERE zip = $1`,
        [parts.zip.slice(0, 5)],
      );
      const hit = res.rows[0];
      // The ZIP's state must not contradict a state the address names.
      if (hit && (!parts.state || parts.state === hit.state)) {
        parts.city = parts.city ?? hit.city;
        parts.state = parts.state ?? hit.state;
      }
    } catch (err) {
      // On the pool a failed lookup only loses the completion. Inside a
      // transaction Postgres aborts it anyway; geo_zip exists since 0056.
      console.error('[addressFill] ZIP lookup failed', err);
      if (q !== POOL) throw err;
    }
  }
  return addressPartValues(parts);
}

/**
 * Write the parts into `bag` (mutated) and return what changed. `explicit` is
 * the set of bag keys the same save set on purpose — those are left alone.
 */
export async function fillFromAddress(
  bag: Record<string, unknown>,
  explicit: ReadonlySet<string>,
  q: Queryable = POOL,
): Promise<AddressFillChange[]> {
  const values = await addressPartsFor(bag[ADDRESS_KEY], q);
  const changes: AddressFillChange[] = [];
  for (const [key, after] of Object.entries(values) as [AddressPartKey, string][]) {
    if (explicit.has(key)) continue;
    const before = bag[key] ?? null;
    if (String(before ?? '') === after) continue;
    bag[key] = after;
    changes.push({ key, before, after });
  }
  return changes;
}
