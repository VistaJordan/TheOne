// 'Date Created' — stamped by the server the moment a work order comes into
// being, so nobody fills it in by hand afterwards.
//
// The task row's `created_at` already knows the instant, but 'Date Created'
// is the field the operators read, filter and export, so every path that
// INSERTs a task calls stampDateCreated() on the bag first: the Add work
// order form, Submit & assign on an intake draft, a planned-maintenance
// occurrence, a new row in a CSV import (a file that supplies the column is a
// backdated import and keeps its value). The Ecotrak sync carries Ecotrak's
// own creation date instead — see modules/integrations/ecotrak/ingest.ts.
//
// The value is the Chicago wall clock to the minute, zoneless — the same shape
// the datetime editor writes ('YYYY-MM-DDTHH:MM', woFieldValues.ts), so a
// stamped value and a typed value read, filter and round-trip identically.

import { wallStamp } from '../lib/businessDays.js';

export const K_DATE_CREATED = 'Date Created';

/** Fill 'Date Created' IN PLACE when the bag does not already carry one. */
export function stampDateCreated(bag: Record<string, unknown>, now: Date = new Date()): void {
  const cur = bag[K_DATE_CREATED];
  if (cur === undefined || cur === null || (typeof cur === 'string' && cur.trim() === '')) {
    bag[K_DATE_CREATED] = wallStamp(now);
  }
}
