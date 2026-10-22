/* The Where section's second fill: City and State from the ZIP alone.
 *
 * Typing or pasting an address already fills City, State and Zip Code from
 * the text (shared/addressParts.ts, run in the form's `set`). An address
 * that carries only the ZIP ("123 Main St, 77002") names no city or state,
 * so the form asks the API for the place the ZIP table (geo_zip, 0056)
 * names and writes it into the two fields WHILE THEY ARE EMPTY — a hand
 * edit is never overwritten. The API runs the same completion again on the
 * save, so a form that never asked still ends up right. */

import { useEffect } from 'react';
import { ADDRESS_CITY_KEY, ADDRESS_STATE_KEY, parseAddressParts } from '@theone/shared';
import { lookupZip } from '../api/client';

type Values = Record<string, string>;

const DEBOUNCE_MS = 400;

/** Watches `address`; when it carries a ZIP but no readable city or state,
    looks the ZIP up and hands `apply` a function that fills the empty
    fields of the current values. */
export function useAddressFill(address: string | undefined, apply: (fill: (cur: Values) => Values) => void): void {
  useEffect(() => {
    const parts = parseAddressParts(address ?? '');
    if (!parts.zip || (parts.city && parts.state)) return;
    const zip = parts.zip;
    let live = true;
    const t = setTimeout(() => {
      lookupZip(zip)
        .then(({ place }) => {
          if (!live || !place) return;
          apply((cur) => {
            const next = { ...cur };
            if ((cur[ADDRESS_CITY_KEY] ?? '').trim() === '' && place.city) next[ADDRESS_CITY_KEY] = place.city;
            // The ZIP's state must not contradict a state the address names.
            if ((cur[ADDRESS_STATE_KEY] ?? '').trim() === '' && place.state && (!parts.state || parts.state === place.state)) {
              next[ADDRESS_STATE_KEY] = place.state;
            }
            return next;
          });
        })
        .catch(() => {
          /* the save completes it anyway */
        });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // `apply` is a setter wrapper; the address text is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);
}
