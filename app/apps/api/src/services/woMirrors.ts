// Promoted-column mirrors, in their own module so both the field-value writer
// (woFieldValues.ts) and the automations engine can read the map without
// importing each other — those two call each other at run time, and a shared
// top-level constant on either side would make the ESM cycle throw at load.
//
// Seven bag keys are ALSO promoted task columns (seed §5 writes both). A write
// through the field service keeps the mirror in step, or the list page would
// keep showing the old Comp/NTE after the detail page changed it.

export const MIRROR_BY_JSON_KEY: Record<
  string,
  { column: string; cast: 'text' | 'numeric' | 'date' }
> = {
  '21. Comp':            { column: 'billing_entity', cast: 'text' },
  'Client':              { column: 'client',         cast: 'text' },
  'Trade':               { column: 'trade',          cast: 'text' },
  'City':                { column: 'city',           cast: 'text' },
  'State':               { column: 'state',          cast: 'text' },
  '16. Client NTE 🔴':   { column: 'nte',            cast: 'numeric' },
  'Date-Time Received':  { column: 'date_received',  cast: 'date' },
  '35. WO Description':  { column: 'description',    cast: 'text' },
};
