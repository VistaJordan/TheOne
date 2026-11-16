/* 0140 · The Address box, with Google Maps suggestions (Elise, 2026-11-15).
 *
 * A text box first: whatever is typed is the value, so an address Google
 * does not know (a new build, a unit inside a mall) is still accepted. While
 * it is typed, the addresses Google Maps knows are listed under it — as
 * ClickUp's location field does — and picking one writes Google's own
 * spelling of it, ZIP included, which then fills Street Address, City, State
 * and Zip Code like any typed address (shared/addressParts.ts).
 *
 * The browser asks OUR API (routes/address.ts); the key stays on the server.
 * When the API says suggestions are off (the Google Maps switch in Admin ›
 * Integrations, no key, today's cap), the box simply stops asking for a few
 * minutes and behaves as the plain text box it was. */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  ADDRESS_SUGGEST_DEBOUNCE_MS,
  addressSuggestWorthAsking,
  type AddressSuggestion,
} from '@theone/shared';
import { fetchAddressPlace, suggestAddresses } from '../api/client';

// Shared by every Address box on the page: once the API says "not available"
// nobody asks again until this time has passed.
const OFF_FOR_MS = 5 * 60_000;
let offUntil = 0;
/** True once a suggestions request has come back available in this tab. */
let knownAvailable = false;

const newSession = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

interface Props {
  id?: string;
  className?: string;
  value: string;
  /** Every keystroke. */
  onChange: (text: string) => void;
  /** A suggestion was picked: Google's full address. Defaults to onChange. */
  onPick?: (address: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  /** Keys the list did not use (Enter with the list closed, Escape…). */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** Draw the "checked / not checked against Google Maps" line under the box. */
  hint?: boolean;
}

export function AddressInput({ id, className, value, onChange, onPick, disabled, autoFocus, placeholder, onKeyDown, hint }: Props) {
  const listId = useId();
  const [items, setItems] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [picking, setPicking] = useState(false);
  /** The address the last pick wrote; while the value still equals it, the
      box holds an address Google knows. */
  const [picked, setPicked] = useState<string | null>(null);
  const [available, setAvailable] = useState(knownAvailable);
  const session = useRef(newSession());
  /** Only text the person typed is looked up — never a value that arrived
      from a pick, a template or the saved record. */
  const typed = useRef(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!typed.current) return;
    if (!addressSuggestWorthAsking(value) || Date.now() < offUntil) {
      setItems([]);
      setOpen(false);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      suggestAddresses(value.trim(), session.current, ctl.signal)
        .then((r) => {
          if (ctl.signal.aborted) return;
          if (!r.available) {
            offUntil = Date.now() + OFF_FOR_MS;
            knownAvailable = false;
            setAvailable(false);
            setItems([]);
            setOpen(false);
            return;
          }
          knownAvailable = true;
          setAvailable(true);
          setItems(r.suggestions);
          setActive(0);
          setOpen(focused.current && r.suggestions.length > 0);
        })
        .catch(() => {
          /* typing carries on without suggestions */
        });
    }, ADDRESS_SUGGEST_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [value]);

  const pick = (s: AddressSuggestion) => {
    const token = session.current;
    // The pick ends Google's session; the next address typed starts another.
    session.current = newSession();
    typed.current = false;
    setOpen(false);
    setItems([]);
    setPicking(true);
    const write = (address: string) => {
      setPicked(address);
      (onPick ?? onChange)(address);
    };
    fetchAddressPlace(s.place_id, token)
      .then((r) => write(r.place?.address ?? [s.main, s.secondary].filter(Boolean).join(', ')))
      .catch(() => write([s.main, s.secondary].filter(Boolean).join(', ')))
      .finally(() => setPicking(false));
  };

  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open && items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, items.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const s = items[active];
        if (s) pick(s);
        return;
      }
      if (e.key === 'Escape') {
        // Closes the list only; a second Escape reaches the form.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        return;
      }
    }
    onKeyDown?.(e);
  };

  const text = value.trim();
  const checked = picked !== null && picked.trim() === text;
  const showHint = Boolean(hint) && text !== '' && (checked || available);

  return (
    <span className="addr">
      <span className="addr-box">
        <input
          id={id}
          className={className}
          type="text"
          value={value}
          placeholder={placeholder}
          disabled={disabled || picking}
          autoFocus={autoFocus}
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && items[active] ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            typed.current = true;
            onChange(e.target.value);
          }}
          onFocus={() => {
            focused.current = true;
            if (items.length > 0 && typed.current) setOpen(true);
          }}
          onBlur={() => {
            focused.current = false;
            setOpen(false);
          }}
          onKeyDown={keyDown}
        />
        {open && items.length > 0 && (
          <span className="addr-pop" role="listbox" id={listId}>
            {items.map((s, i) => (
              <button
                type="button"
                role="option"
                id={`${listId}-${i}`}
                aria-selected={i === active}
                key={s.place_id}
                className={`addr-opt${i === active ? ' is-active' : ''}`}
                // mousedown would blur the box and close the list before the click.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(s)}
              >
                <b>{s.main}</b>
                {s.secondary && <small>{s.secondary}</small>}
              </button>
            ))}
            <span className="addr-by">powered by Google</span>
          </span>
        )}
      </span>
      {showHint && (
        <span className={`addr-hint${checked ? ' is-checked' : ''}`}>
          {checked
            ? 'Address from Google Maps'
            : 'Not checked against Google Maps'}
        </span>
      )}
    </span>
  );
}
