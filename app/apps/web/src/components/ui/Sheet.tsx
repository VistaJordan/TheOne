/* The dialog every newer module uses: a scrim, a sheet, a title, a form grid,
 * an error line and a footer. Escape closes it. Kept deliberately small — the
 * classes are the ones the portfolio dialogs already use. */

import type { ReactNode } from 'react';
import type { IconName } from '../Icon';
import { Icon } from '../Icon';
import { useEscape } from '../../lib/useEscape';
import { ApiRequestError } from '../../api/client';

export const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : fallback);
export const usd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
export const dayText = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
export const stampText = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
/** '' → null, otherwise the number (NaN → null). */
export const numOrNull = (s: string): number | null => {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function Sheet({ title, icon, onClose, children, footer, problem, wide = true }: {
  title: ReactNode;
  icon?: IconName;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  problem?: string | null;
  wide?: boolean;
}) {
  useEscape(onClose);
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
      <div className={`sheet vend-sheet pf-sheet${wide ? ' is-wide' : ''}`}>
        <h2 className="sheet-t">{icon && <Icon name={icon} size={16} />}{title}</h2>
        {children}
        {problem && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{problem}</p>}
        <div className="sheet-f">{footer}</div>
      </div>
    </div>
  );
}

/** One labelled field of a `.pf-form` grid. */
export function F({ label, children, wide, hint }: { label: string; children: ReactNode; wide?: boolean; hint?: string }) {
  return (
    <label className={`pf-field${wide ? ' is-wide' : ''}`}>
      <span className="lbl">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/** The tab strip of a multi-part page, kept in the URL as ?tab=. */
export function PageTabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number | null }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="seg mt-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} className={`seg-btn${value === t.id ? ' is-on' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && t.count !== null && t.count > 0 && <span className="mt-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
