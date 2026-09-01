// Shared inline-editing machinery for work-order fields. Extracted from
// AllFieldsPanel (S7) so EVERY tab can edit the fields it displays, not just
// the All-fields catalogue: the tab cards wrap their values in <InlineField>
// and get the same typed editors, the same permission gate
// (can.edit_wo_fields — enforced again server-side) and the same save path.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WoFieldDescriptor } from '@theone/shared';
import {
  ApiRequestError,
  getWoFields,
  patchWorkOrderFields,
  type WorkOrderDetailV2,
} from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DASH, bool, fieldValueToString, money, num, shortDate, shortDateTime } from '../../lib/fields';
import { Icon } from '../Icon';

const isUrlValue = (s: string) => /^https?:\/\//i.test(s);

/** Read-only rendering of one value, typed by its descriptor. */
export function displayValue(f: WoFieldDescriptor, raw: unknown): ReactNode {
  if (f.type === 'boolean') {
    return <span className={bool(raw) ? 'afp-yes' : 'afp-no'}>{bool(raw) ? 'Yes' : 'No'}</span>;
  }
  if (raw === null || raw === undefined || raw === '') return DASH;
  if (f.type === 'money') {
    const n = num(raw);
    return n === null ? fieldValueToString(raw) : money(n);
  }
  if (f.type === 'date') {
    const s = String(raw);
    return shortDate(s) ?? fieldValueToString(raw);
  }
  if (f.type === 'datetime') {
    return shortDateTime(String(raw)) ?? fieldValueToString(raw);
  }
  const text = fieldValueToString(raw);
  if (isUrlValue(text)) {
    return (
      <a href={text} target="_blank" rel="noreferrer">
        {text}
      </a>
    );
  }
  return text;
}

/** The value an editor starts from, as a string the input can hold. */
export function draftOf(f: WoFieldDescriptor, raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (f.type === 'date') return String(raw).slice(0, 10);
  if (f.type === 'datetime') {
    // datetime-local refuses a bare date, so a day-only value gets midnight.
    const s = String(raw).replace(' ', 'T');
    return s.length >= 16 ? s.slice(0, 16) : s.length === 10 ? `${s}T00:00` : s;
  }
  if (f.type === 'money' || f.type === 'number') {
    const n = num(raw);
    return n === null ? '' : String(n);
  }
  return String(raw);
}

/** The field catalogue as a by-key map — every tab shares the one query. */
export function useWoCatalogue(): Map<string, WoFieldDescriptor> {
  const catalogue = useQuery({
    queryKey: ['wo-fields'],
    queryFn: getWoFields,
    staleTime: 5 * 60 * 1000,
  });
  return useMemo(
    () => new Map((catalogue.data?.fields ?? []).map((f) => [f.key, f])),
    [catalogue.data],
  );
}

/** True when the ACTING principal may edit fields (same rule as the server). */
export function useCanEditFields(): boolean {
  const { actingAs } = useAuth();
  return Boolean(actingAs?.can?.edit_wo_fields);
}

/** One field-save mutation. Invalidates broadly (['work-orders'] covers the
    detail and the list) rather than swapping the detail in by key, so it works
    from any tab card without threading the detail query key through. */
export function useWoFieldSave(woId: string, onSaved?: () => void) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (input: { key: string; value: unknown }) =>
      patchWorkOrderFields(woId, { [input.key]: input.value }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
      void qc.invalidateQueries({ queryKey: ['wo-activity'] });
      void qc.invalidateQueries({ queryKey: ['wo-feed'] });
      void qc.invalidateQueries({ queryKey: ['wo-field-history', woId] });
      setError(null);
      onSaved?.();
    },
    onError: (err) => {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save this field');
    },
  });
  return { mutate: mutation.mutate, isPending: mutation.isPending, error, clearError: () => setError(null) };
}

interface InlineFieldProps {
  wo: WorkOrderDetailV2;
  /** Catalogue key (`fields.<bag key>`) — the storage address. */
  fieldKey: string;
  /** Custom display; defaults to the typed displayValue rendering. */
  children?: ReactNode;
  /** Accessible name for the pencil ("Edit <label>"); defaults to the field label. */
  label?: string;
  className?: string;
}

/**
 * A value that edits in place, for the tab cards. Renders the given display
 * (or the typed default), a pencil that swaps in the typed editor, and saves
 * through the shared PATCH path. Renders read-only — no pencil — when the
 * principal lacks edit_wo_fields, when the field is not in the catalogue, or
 * when it is computed (formula/attachment). Booleans render as a live checkbox.
 */
export function InlineField({ wo, fieldKey, children, label, className }: InlineFieldProps) {
  const canEdit = useCanEditFields();
  const byKey = useWoCatalogue();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const save = useWoFieldSave(wo.id, () => setEditing(false));

  const f = byKey.get(fieldKey);
  const jsonKey = fieldKey.startsWith('fields.') ? fieldKey.slice('fields.'.length) : fieldKey;
  const raw = (wo.fields ?? {})[jsonKey];

  const readOnly = !f || f.subtype === 'formula' || f.subtype === 'attachment';
  if (!canEdit || readOnly) {
    return <span className={className}>{children ?? (f ? displayValue(f, raw) : DASH)}</span>;
  }

  if (f.type === 'boolean') {
    return (
      <label className={['afp-check', className].filter(Boolean).join(' ')}>
        <input
          type="checkbox"
          checked={bool(raw)}
          disabled={save.isPending}
          onChange={(e) => save.mutate({ key: fieldKey, value: e.target.checked })}
        />
        <span>{bool(raw) ? 'Yes' : 'No'}</span>
      </label>
    );
  }

  if (editing) {
    return (
      <span className={['ife is-editing', className].filter(Boolean).join(' ')}>
        <FieldEditor
          field={f}
          draft={draft}
          onDraft={setDraft}
          onSave={() => save.mutate({ key: fieldKey, value: draft.trim() === '' ? null : draft })}
          onPick={(v) => save.mutate({ key: fieldKey, value: v === '' ? null : v })}
          onCancel={() => { setEditing(false); save.clearError(); }}
          saving={save.isPending}
        />
        {save.error && <span className="ife-err" role="alert">{save.error}</span>}
      </span>
    );
  }

  return (
    <span className={['ife', className].filter(Boolean).join(' ')}>
      {children ?? displayValue(f, raw)}
      <button
        type="button"
        className="afp-act ife-pencil"
        title={`Edit ${label ?? f.label}`}
        onClick={() => { setDraft(draftOf(f, raw)); setEditing(true); }}
      >
        <Icon name="pencil" size={12} />
      </button>
    </span>
  );
}

// ── Inline editor, typed by subtype ──────────────────────────────────────────

export function FieldEditor({
  field,
  draft,
  onDraft,
  onSave,
  onPick,
  onCancel,
  saving,
}: {
  field: WoFieldDescriptor;
  draft: string;
  onDraft: (v: string) => void;
  onSave: () => void;
  /** Select fields save the moment an option is picked — no ✓ step. */
  onPick: (value: string) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && field.subtype !== 'long_text') {
      e.preventDefault();
      onSave();
    }
    if (e.key === 'Escape') onCancel();
  };

  let input: ReactNode;
  if (field.type === 'select') {
    input = (
      <ComboSelect
        options={field.options ?? []}
        current={draft}
        saving={saving}
        onPick={onPick}
        onCancel={onCancel}
      />
    );
  } else if (field.subtype === 'long_text') {
    input = (
      <textarea
        rows={4}
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
      />
    );
  } else {
    const type =
      field.type === 'date' ? 'date'
      : field.type === 'datetime' ? 'datetime-local'
      : field.type === 'money' || field.type === 'number' ? 'number'
      : field.subtype === 'phone' ? 'tel'
      : field.subtype === 'url' ? 'url'
      : 'text';
    input = (
      <input
        type={type}
        step={field.type === 'money' ? '0.01' : undefined}
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
      />
    );
  }

  return (
    <span className="afp-editor">
      {input}
      {field.type !== 'select' && (
        <button type="button" className="afp-act is-save" title="Save" onClick={onSave} disabled={saving}>
          <Icon name="check" size={12} />
        </button>
      )}
      <button type="button" className="afp-act" title="Cancel" onClick={onCancel} disabled={saving}>
        <Icon name="x" size={12} />
      </button>
    </span>
  );
}

// ── Searchable option picker (dropdown fields — FM alone has ~125 options) ───

export function ComboSelect({
  options,
  current,
  saving,
  onPick,
  onCancel,
}: {
  options: { value: string; label: string }[];
  current: string;
  saving: boolean;
  onPick: (value: string) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);

  // A value that predates the current vocabulary must stay pickable.
  const all = useMemo(
    () =>
      current !== '' && !options.some((o) => o.value === current)
        ? [{ value: current, label: current }, ...options]
        : options,
    [options, current],
  );

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? all.filter(
        (o) => o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle),
      )
    : all;

  useEffect(() => {
    setActive(0);
  }, [needle]);

  useEffect(() => {
    popRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onCancel();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onCancel]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onCancel();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) onPick(shown[active].value);
    }
  };

  return (
    <span className="combo" ref={rootRef}>
      <input
        type="search"
        autoFocus
        value={q}
        placeholder={current || 'Search…'}
        disabled={saving}
        aria-label="Search options"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="combo-pop" role="listbox" ref={popRef}>
        {current !== '' && needle === '' && (
          <button type="button" className="combo-opt is-clear" disabled={saving} onClick={() => onPick('')}>
            — clear —
          </button>
        )}
        {shown.map((o, i) => (
          <button
            type="button"
            role="option"
            aria-selected={o.value === current}
            key={o.value}
            className={`combo-opt${i === active ? ' is-active' : ''}${o.value === current ? ' is-current' : ''}`}
            disabled={saving}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(o.value)}
          >
            {o.label}
            {o.value === current && <span className="combo-check">✓</span>}
          </button>
        ))}
        {shown.length === 0 && <span className="combo-none">No match for “{q}”</span>}
      </span>
    </span>
  );
}
