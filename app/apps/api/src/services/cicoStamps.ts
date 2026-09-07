// Check-in / check-out stamps (2026-09-07).
//
// The operation needs to know WHEN a technician checked in and out, to the
// second, as a value on the work order — not only as a line in the audit trail.
// A dashboard column, an export or a future time-on-site figure all need a
// field they can read directly.
//
// So a write that moves "18. Check-in/out Status" also writes:
//   → 'Checked-in'                    Checked-in At  = now
//   → 'Checked-out' / '… - RTN'       Checked-out At = now
//
// The stamp is UTC ISO with seconds ('2026-09-07T13:26:09Z'); the web renders
// it in the viewer's local time. It is a plain datetime custom field, so an
// operator can still correct it by hand — and a patch that sets the stamp
// explicitly alongside the status is taken as that correction and left alone.
//
// Both bag write paths call this (woFieldValues for the inline editor and the
// automations engine, woBulk for the list's bulk edit), so the stamp is true
// whichever way the status moved.

import type { TaskChange } from './woAudit.js';

export const CICO_STATUS_KEY = '18. Check-in/out Status';
export const CHECKED_IN_AT_KEY = 'Checked-in At';
export const CHECKED_OUT_AT_KEY = 'Checked-out At';

/** Which stamp a status value earns, if any. The production dropdown numbers
    its options ('1. Checked-in', '2. Checked-out') and the seed does not, so
    a leading "N." is ignored and the hyphen is optional. */
export function cicoStampKeyFor(status: unknown): string | null {
  if (typeof status !== 'string') return null;
  const s = status.trim().toLowerCase().replace(/^\d+[.)]?\s*/, '');
  if (/^checked[\s-]?in\b/.test(s)) return CHECKED_IN_AT_KEY;
  if (/^checked[\s-]?out\b/.test(s)) return CHECKED_OUT_AT_KEY;
  return null;
}

/** Now, to the second, in UTC. */
export function cicoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Add the stamp a status change in `log` earns to `merged` (the bag about to
 * be written) and return the extra change so it is audited like any other
 * field write. `explicitKeys` are the bag keys the caller's patch named — a
 * stamp among them is the operator's own value and is not overwritten.
 */
export function applyCicoStamps(
  merged: Record<string, unknown>,
  log: TaskChange[],
  explicitKeys: Iterable<string>,
): TaskChange[] {
  const statusChange = log.find((c) => c.field === `fields.${CICO_STATUS_KEY}`);
  if (!statusChange) return [];
  const stampKey = cicoStampKeyFor(statusChange.after);
  if (!stampKey) return [];
  for (const k of explicitKeys) if (k === stampKey) return [];

  const before = merged[stampKey] ?? null;
  const now = cicoNow();
  merged[stampKey] = now;
  return [{ field: `fields.${stampKey}`, before, after: now }];
}
