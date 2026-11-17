/* Fold one quote section (Incurred, Option 1, Option 2…) to its title and
   total, and open it again (UAT #9, Elise 2026-11-16). The button sits at the
   top right of the section's card and folds the nearest `[data-fold]`
   ancestor (it sets `data-folded`, which React does not manage, so a
   re-render of the card's own className never undoes it; quote.css hides the
   body). The choice is remembered per browser, per section; a Submit attempt
   that finds problems (`forceOpen`) opens every section again so nothing
   missing hides. */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';

const STORE_KEY = 'theone.quote.folded';

function readFolded(): Set<string> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeFolded(key: string, folded: boolean): void {
  try {
    const set = readFolded();
    if (folded) set.add(key);
    else set.delete(key);
    // Keep the list short: the most recent 200 sections.
    localStorage.setItem(STORE_KEY, JSON.stringify([...set].slice(-200)));
  } catch {
    /* storage disabled — the fold simply does not survive the reload */
  }
}

interface SectionFoldButtonProps {
  /** The section's key (its saved id once saved). */
  foldKey: string;
  /** "Incurred", "Option A", … — read by the button's label. */
  label: string;
  /** A Submit attempt found problems: open it again. */
  forceOpen?: boolean;
}

export function SectionFoldButton({ foldKey, label, forceOpen = false }: SectionFoldButtonProps) {
  const [folded, setFolded] = useState(() => readFolded().has(foldKey));
  const ref = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (forceOpen && folded) {
      setFolded(false);
      writeFolded(foldKey, false);
    }
  }, [forceOpen, folded, foldKey]);

  useLayoutEffect(() => {
    const card = ref.current?.closest<HTMLElement>('[data-fold]');
    if (!card) return;
    if (folded) card.setAttribute('data-folded', 'true');
    else card.removeAttribute('data-folded');
  }, [folded]);

  const toggle = () => {
    setFolded((f) => {
      writeFolded(foldKey, !f);
      return !f;
    });
  };
  const text = folded ? `Expand ${label}` : `Collapse ${label}`;
  return (
    <button
      ref={ref}
      type="button"
      className="btn btn-icon btn-sm sec-fold-btn"
      aria-expanded={!folded}
      aria-label={text}
      title={text}
      onClick={toggle}
    >
      <Icon name={folded ? 'chev-d' : 'chev-u'} size={14} />
    </button>
  );
}
