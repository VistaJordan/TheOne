/* 0057 · The technician box of a visit: still a plain text box (a name can be
   typed by hand, as before), with the records underneath as you type — the
   technicians hired on this work order first, then anyone on file, whoever
   owns them. Picking one fills the phone too and remembers which record it
   was, which is what puts that technician on the picker's own map next time. */

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TechSearchHit } from '@theone/shared';
import { searchWoTechs } from '../../../api/client';

interface TechPickerProps {
  /** The work order's id or number. */
  woId: string;
  value: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Typed by hand — the caller should forget any picked record. */
  onChange: (name: string) => void;
  onPick: (hit: TechSearchHit) => void;
}

export function TechPicker({ woId, value, disabled, autoFocus, onChange, onPick }: TechPickerProps) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState(value);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLSpanElement>(null);

  // Debounce what is asked of the server, not what is shown in the box.
  useEffect(() => {
    const t = window.setTimeout(() => setTerm(value), 220);
    return () => window.clearTimeout(t);
  }, [value]);

  const hits = useQuery({
    queryKey: ['wo-tech-search', woId, term.trim()],
    queryFn: () => searchWoTechs(woId, term.trim()),
    enabled: open,
    staleTime: 20_000,
  });
  const list = hits.data?.hits ?? [];

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const pick = (h: TechSearchHit) => {
    onPick(h);
    setOpen(false);
  };

  return (
    <span className="techpick" ref={box}>
      <input
        className="fld"
        value={value}
        placeholder="Name — type to search"
        disabled={disabled}
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded={open && list.length > 0}
        aria-autocomplete="list"
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (!open || list.length === 0) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(list.length - 1, i + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
          else if (e.key === 'Enter' && list[active]) { e.preventDefault(); pick(list[active]); }
          else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
        }}
      />
      {open && list.length > 0 && (
        <ul className="techpick-menu" role="listbox">
          {list.map((h, i) => (
            <li key={h.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={`techpick-opt${i === active ? ' is-on' : ''}`}
                // mousedown, not click: the input must not lose focus first.
                onMouseDown={(e) => { e.preventDefault(); pick(h); }}
                onMouseEnter={() => setActive(i)}
              >
                <b>{h.name}</b>
                <span>
                  {[h.phone, h.primary_trade, [h.city, h.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                </span>
                {h.hired && <span className="chip chip-accent chip-sm">Hired here</span>}
                {h.blacklisted && <span className="chip chip-danger chip-sm">Blacklisted</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
