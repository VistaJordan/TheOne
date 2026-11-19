/* Vendor (technician) typeahead for the payment request — Yoda looks the
   Technician up by phone; here the operator can search by name or phone and
   pick the record, which brings the compliance flags (W9 on file, COI expiry,
   blacklist) along for free. A miss falls back to manual name + phone, which
   the API turns into a vendor record on submit. Since UAT #7 (2026-11-16) a
   search with no match offers "Add … as a new technician" right there, with
   what was typed carried over (a phone into Phone, a name into the name). */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchVendors } from '../../api/client';
import type { Vendor } from '../../api/client';
import { Icon } from '../Icon';

export interface ManualPrefill {
  name: string;
  phone: string;
}

interface Props {
  trade: string | null;
  onPick: (v: Vendor) => void;
  onManual: (prefill: ManualPrefill) => void;
}

/** What was typed, read as a phone (7+ digits and nothing but phone marks) or a name. */
export function prefillFromSearch(q: string): ManualPrefill {
  const t = q.trim();
  const digits = t.replace(/\D/g, '');
  const phoneLike = digits.length >= 7 && /^[\d\s()+.-]+$/.test(t);
  return phoneLike ? { name: '', phone: t } : { name: t, phone: '' };
}

export function VendorPicker({ trade, onPick, onManual }: Props) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const query = useQuery({
    queryKey: ['vendors', 'search', debounced, trade],
    queryFn: () => searchVendors(debounced, null),
    enabled: debounced.length >= 2,
    staleTime: 30_000,
  });

  const items = useMemo(() => {
    const list = query.data?.items ?? [];
    // Same-trade techs first — the picker is almost always for this WO's trade.
    return [...list].sort((a, b) => Number(b.trades.includes(trade ?? '')) - Number(a.trades.includes(trade ?? '')));
  }, [query.data, trade]);

  return (
    <div className="vpick vpick-search" role="group" aria-labelledby="lbl-vendor">
      <div className="field">
        <label className="flabel" htmlFor="vendor-q">Search the vendor list</label>
        <div className="amtwrap">
          <span className="amt-cur" aria-hidden="true"><Icon name="search" size={14} /></span>
          <input
            className="amt-in"
            id="vendor-q"
            type="text"
            placeholder="Name or phone"
            value={q}
            autoComplete="off"
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>
      {debounced.length >= 2 && (
        <ul className="vpick-results" aria-label="Matching vendors">
          {query.isLoading && <li className="vpick-row is-muted">Searching…</li>}
          {!query.isLoading && items.length === 0 && (
            <li>
              <button type="button" className="vpick-row vpick-add" onClick={() => onManual(prefillFromSearch(debounced))}>
                <span className="vpick-row-name">
                  <Icon name="user-plus" size={14} />
                  Add “{debounced}” as a new technician
                </span>
                <span className="vpick-row-sub">
                  No vendor matches — it is saved to the vendor list when you submit
                </span>
              </button>
            </li>
          )}
          {items.map((v) => (
            <li key={v.id}>
              <button type="button" className="vpick-row" onClick={() => onPick(v)}>
                <span className="vpick-row-name">
                  {v.name}
                  {v.is_blacklisted && <span className="chip chip-sm chip-danger">Blacklisted</span>}
                  {!v.is_w9_present && <span className="chip chip-sm chip-outline">No W9</span>}
                </span>
                <span className="vpick-row-sub">
                  {[v.phone, v.trades.join(', '), [v.city, v.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="fallback">
        <Icon name="user-plus" size={14} />
        <button type="button" className="linkbtn" onClick={() => onManual(prefillFromSearch(q))}>
          Technician not in the vendor list? Enter a name and phone manually
        </button>
      </div>
    </div>
  );
}
