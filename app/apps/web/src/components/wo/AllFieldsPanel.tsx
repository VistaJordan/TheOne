// The "All fields" tab (S7) — the curated catalogue rendered as a two-column
// list with search, inline editing, per-field history and per-USER ordering.
//
// What renders is the CATALOGUE (every defined field, valued or not), not the
// raw JSONB bag: an empty field must be visible to be fillable, and bag keys an
// admin has not defined are deliberately invisible until re-added in
// Admin › Custom fields.
//
// Ordering has three modes:
//   default   the operator's SECTIONS (lib/woFieldSections.ts — Client,
//             Finances, Site, …), each section's fields in the specified order
//   alpha     A→Z by label, one flat list
//   manual    the user's own drag order, one flat list
// Comp is in no section and no list: it renders as a control beside the
// search box, always visible.
// The choice + the manual order persist server-side per ACCOUNT (user_pref,
// key 'wo.fields.order'), so it follows the person to any machine and applies
// to every work order — and to nobody else.
//
// Permissions ride on the ACTING principal (same rule as the server):
//   can.edit_wo_fields     → inline editors
//   can.view_field_history → the per-row history drawer

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';
import type { ActivityEntry, WoFieldDescriptor } from '@theone/shared';
import {
  ApiRequestError,
  getFieldHistory,
  getUserPref,
  getWoFields,
  patchWorkOrderFields,
  setUserPref,
  type WorkOrderDetailV2,
} from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { useReorder } from '../../hooks/useReorder';
import {
  COMP_FIELD_KEY,
  FIELD_SECTIONS,
  MORE_SECTION_ICON,
  MORE_SECTION_TITLE,
} from '../../lib/woFieldSections';
import type { IconName } from '../Icon';
import { DASH, bool, feedTime, fieldValueToString, initials } from '../../lib/fields';
import { formatValue, unwrap } from '../../lib/auditFormat';
import { Icon } from '../Icon';

import { FieldEditor, displayValue as display, draftOf } from './fieldEdit';

const ORDER_PREF_KEY = 'wo.fields.order';

type OrderMode = 'default' | 'alpha' | 'manual';

interface OrderPref {
  mode: OrderMode;
  /** Catalogue keys in the user's chosen order (manual mode). */
  order?: string[];
}

interface AllFieldsPanelProps {
  wo: WorkOrderDetailV2;
  /** The detail query's key, so a save can swap in the fresh detail. */
  detailKey: QueryKey;
}

// display/draftOf/FieldEditor/ComboSelect moved to ./fieldEdit so every tab
// card can reuse them — this panel keeps the ordering, search and history.

export function AllFieldsPanel({ wo, detailKey }: AllFieldsPanelProps) {
  const { actingAs } = useAuth();
  const canEdit = Boolean(actingAs?.can?.edit_wo_fields);
  const canHistory = Boolean(actingAs?.can?.view_field_history);

  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const catalogue = useQuery({
    queryKey: ['wo-fields'],
    queryFn: getWoFields,
    staleTime: 5 * 60 * 1000,
  });

  // Every custom (bag-backed) field, in ADMIN order — the catalogue is already
  // sorted by field_def.position. Comp is pulled out of the list: it renders
  // as a toolbar control beside the search box instead.
  const fields = useMemo(
    () => (catalogue.data?.fields ?? []).filter((f) => f.custom && f.key !== COMP_FIELD_KEY),
    [catalogue.data],
  );
  const compField = useMemo(
    () => (catalogue.data?.fields ?? []).find((f) => f.key === COMP_FIELD_KEY) ?? null,
    [catalogue.data],
  );

  // ── Per-user order ─────────────────────────────────────────────────────────
  const prefQuery = useQuery({
    queryKey: ['user-pref', ORDER_PREF_KEY],
    queryFn: () => getUserPref<OrderPref>(ORDER_PREF_KEY),
    staleTime: 5 * 60 * 1000,
  });
  // Local override wins the moment the user touches the control; the server
  // copy is the cross-machine backup, not the render path.
  const [localPref, setLocalPref] = useState<OrderPref | null>(null);
  const pref: OrderPref = localPref ?? prefQuery.data?.value ?? { mode: 'default' };

  const savePref = (next: OrderPref) => {
    setLocalPref(next);
    void setUserPref(ORDER_PREF_KEY, next).catch(() => {
      /* a failed pref write only costs cross-machine sync — never block the UI */
    });
  };

  const ordered = useMemo(() => {
    if (pref.mode === 'alpha') {
      return [...fields].sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
    }
    if (pref.mode === 'manual' && pref.order?.length) {
      const at = new Map(pref.order.map((k, i) => [k, i]));
      // Fields the stored order has never seen (new admin fields) keep their
      // admin position relative to each other, after the ordered ones.
      return [...fields].sort((a, b) => {
        const ia = at.get(a.key) ?? pref.order!.length + fields.indexOf(a);
        const ib = at.get(b.key) ?? pref.order!.length + fields.indexOf(b);
        return ia - ib;
      });
    }
    return fields;
  }, [fields, pref]);

  const needle = q.trim().toLowerCase();
  const matches = (f: WoFieldDescriptor) =>
    !needle || f.label.toLowerCase().includes(needle) || f.key.toLowerCase().includes(needle);
  const shown = ordered.filter(matches);

  // Default mode renders the operator's sections; a field the config does not
  // name still shows, under a trailing catch-all heading.
  const sections = useMemo(() => {
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const used = new Set<string>();
    const out: { title: string; icon: IconName; wide?: boolean; fields: WoFieldDescriptor[] }[] = [];
    for (const s of FIELD_SECTIONS) {
      const members = s.keys
        .map((k) => byKey.get(k))
        .filter((f): f is WoFieldDescriptor => Boolean(f));
      for (const f of members) used.add(f.key);
      if (members.length > 0) out.push({ title: s.title, icon: s.icon, wide: s.wide, fields: members });
    }
    const rest = fields.filter((f) => !used.has(f.key));
    if (rest.length > 0) out.push({ title: MORE_SECTION_TITLE, icon: MORE_SECTION_ICON, fields: rest });
    return out;
  }, [fields]);
  const shownSections = sections
    .map((s) => ({ ...s, fields: s.fields.filter(matches) }))
    .filter((s) => s.fields.length > 0);

  const setMode = (mode: OrderMode) => {
    if (mode === 'manual') {
      // First switch: freeze whatever is on screen as the starting order.
      savePref({ mode, order: pref.order?.length ? pref.order : ordered.map((f) => f.key) });
    } else {
      savePref({ ...pref, mode });
    }
  };

  const reorder = useReorder((from, to) => {
    if (to < 0 || to >= ordered.length) return;
    const keys = ordered.map((f) => f.key);
    const [moved] = keys.splice(from, 1);
    keys.splice(to, 0, moved);
    savePref({ mode: 'manual', order: keys });
  });
  // Dragging only makes sense over the FULL list — a filtered index would move
  // the wrong row.
  const dragEnabled = pref.mode === 'manual' && needle === '';

  // ── Saving a value ─────────────────────────────────────────────────────────
  const save = useMutation({
    mutationFn: (input: { key: string; value: unknown }) =>
      patchWorkOrderFields(wo.id, { [input.key]: input.value }),
    onSuccess: (res) => {
      qc.setQueryData(detailKey, res.detail);
      // The list page mirrors several of these values; the trail grew a row.
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
      void qc.invalidateQueries({ queryKey: ['wo-activity'] });
      void qc.invalidateQueries({ queryKey: ['wo-feed'] });
      void qc.invalidateQueries({ queryKey: ['wo-field-history', wo.id] });
      setEditing(null);
      setSaveError(null);
    },
    onError: (err) => {
      setSaveError(err instanceof ApiRequestError ? err.message : 'Could not save this field');
    },
  });

  const startEdit = (f: WoFieldDescriptor) => {
    setSaveError(null);
    setEditing(f.key);
    setDraft(draftOf(f, valueOf(f)));
  };

  const valueOf = (f: WoFieldDescriptor): unknown => {
    const jsonKey = f.key.startsWith('fields.') ? f.key.slice('fields.'.length) : f.key;
    return (wo.fields ?? {})[jsonKey];
  };

  const commit = (f: WoFieldDescriptor) => {
    save.mutate({ key: f.key, value: draft.trim() === '' ? null : draft });
  };

  // One row, shared by the sectioned (default) and flat (alpha/manual) paths.
  // `i` only matters when dragging is possible — the sectioned path passes -1.
  const renderRow = (f: WoFieldDescriptor, i: number) => {
    const raw = valueOf(f);
    const readOnly = f.subtype === 'formula' || f.subtype === 'attachment';
    const isEditing = editing === f.key;
    const rowProps = dragEnabled ? reorder.rowProps(i) : {};
    // Click-to-edit: the value itself opens the editor (links inside a value
    // still open the link); the pencil stays as the visible affordance.
    // EXCEPT long text: there a click expands/collapses the 2-line preview
    // instead — editing a paragraph stays on the pencil so the two gestures
    // don't collide.
    const isLongText =
      f.subtype === 'long_text' && raw !== null && raw !== undefined && String(raw) !== '';
    const canEditField = canEdit && !readOnly && f.type !== 'boolean';
    const editable = canEditField && !isLongText;
    return (
      <div key={f.key}>
        <div
          className={`fieldrow afp-row${dragEnabled ? ' has-grip' : ''}${reorder.dragging === i && dragEnabled ? ' is-dragging' : ''}`}
          {...rowProps}
        >
          {dragEnabled && (
            <button
              type="button"
              className="afp-grip"
              aria-label={`Move ${f.label}`}
              {...reorder.gripProps(i)}
            >
              <Icon name="grip" size={12} />
            </button>
          )}
          <dt>
            {f.label}
            {f.subtype === 'formula' && (
              <span className="afp-fx" title="Computed field — the formula is not wired up yet">ƒ</span>
            )}
          </dt>
          <dd>
            {f.type === 'boolean' && !readOnly ? (
              <label className="afp-check">
                <input
                  type="checkbox"
                  checked={bool(raw)}
                  disabled={!canEdit || save.isPending}
                  onChange={(e) => save.mutate({ key: f.key, value: e.target.checked })}
                />
                <span>{bool(raw) ? 'Yes' : 'No'}</span>
              </label>
            ) : isEditing ? (
              <FieldEditor
                field={f}
                draft={draft}
                onDraft={setDraft}
                onSave={() => commit(f)}
                onPick={(v) => save.mutate({ key: f.key, value: v === '' ? null : v })}
                onCancel={() => { setEditing(null); setSaveError(null); }}
                saving={save.isPending}
              />
            ) : isLongText ? (
              <LongTextValue text={fieldValueToString(raw)} />
            ) : (
              <span
                className={`afp-val${editable ? ' is-editable' : ''}`}
                role={editable ? 'button' : undefined}
                tabIndex={editable ? 0 : undefined}
                title={editable ? `Click to edit ${f.label}` : undefined}
                onClick={
                  editable
                    ? (e) => {
                        if ((e.target as HTMLElement).closest('a')) return;
                        startEdit(f);
                      }
                    : undefined
                }
                onKeyDown={
                  editable
                    ? (e) => {
                        if ((e.target as HTMLElement).closest('a')) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          startEdit(f);
                        }
                      }
                    : undefined
                }
              >
                {display(f, raw)}
              </span>
            )}

            {!isEditing && (
              <span className="afp-actions">
                {canEditField && (
                  <button
                    type="button"
                    className="afp-act"
                    title={`Edit ${f.label}`}
                    onClick={() => startEdit(f)}
                  >
                    <Icon name="pencil" size={12} />
                  </button>
                )}
                {canHistory && (
                  <button
                    type="button"
                    className={`afp-act${historyFor === f.key ? ' is-on' : ''}`}
                    title={`History of ${f.label}`}
                    aria-expanded={historyFor === f.key}
                    onClick={() => setHistoryFor(historyFor === f.key ? null : f.key)}
                  >
                    <Icon name="history" size={12} />
                  </button>
                )}
              </span>
            )}
          </dd>
        </div>
        {historyFor === f.key && canHistory && (
          <FieldHistory woId={wo.id} field={f} />
        )}
      </div>
    );
  };

  if (catalogue.isLoading) {
    return <div className="tab-empty"><span>Loading the field catalogue…</span></div>;
  }
  if (catalogue.isError) {
    return (
      <div className="tab-empty">
        <Icon name="alert" size={22} />
        <b>Field catalogue unavailable</b>
        <span>GET /api/wo-fields did not respond.</span>
      </div>
    );
  }

  return (
    <>
      <div className="card afp-bar">
        <label className="afp-search">
          <Icon name="search" size={12} />
          <input
            type="search"
            placeholder="Search fields…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search fields"
          />
        </label>
        {compField && (
          <label className="afp-comp">
            <span>Comp</span>
            <select
              value={(() => { const v = valueOf(compField); return v == null ? '' : String(v); })()}
              disabled={!canEdit || save.isPending}
              onChange={(e) =>
                save.mutate({ key: compField.key, value: e.target.value === '' ? null : e.target.value })
              }
              aria-label="Comp"
            >
              <option value="">—</option>
              {(() => {
                const v = valueOf(compField);
                const cur = v == null ? '' : String(v);
                const options = compField.options ?? [];
                // A value that predates the current vocabulary must stay selectable.
                return (
                  <>
                    {cur !== '' && !options.some((o) => o.value === cur) && (
                      <option value={cur}>{cur}</option>
                    )}
                    {options.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </>
                );
              })()}
            </select>
          </label>
        )}
        <div className="seg afp-order" role="group" aria-label="Field order">
          <OrderButton mode="default" current={pref.mode} onSelect={setMode}>Default</OrderButton>
          <OrderButton mode="alpha" current={pref.mode} onSelect={setMode}>A–Z</OrderButton>
          <OrderButton mode="manual" current={pref.mode} onSelect={setMode}>My order</OrderButton>
        </div>
      </div>
      {pref.mode === 'manual' && (
        <p className="afp-hint">
          {needle
            ? 'Clear the search to drag fields into your own order.'
            : 'Drag the grip (or use ↑/↓ on it) to arrange fields. This order is yours alone and applies to every work order.'}
        </p>
      )}
      {saveError && <p className="afp-error" role="alert">{saveError}</p>}

      {pref.mode === 'default' ? (
        <div className="afp-sections">
          {shownSections.map((s) => (
            <section className={`card afp-sect${s.wide ? ' is-wide' : ''}`} key={s.title}>
              <h3 className="afp-sect-title">
                <Icon name={s.icon} size={14} />
                {s.title}
              </h3>
              <dl className="fieldlist afp">{s.fields.map((f) => renderRow(f, -1))}</dl>
            </section>
          ))}
          {shownSections.length === 0 && (
            <p className="afp-none">No field matches “{q}”.</p>
          )}
        </div>
      ) : (
        <dl className="card fieldlist afp afp-flat">
          {shown.map((f, i) => renderRow(f, i))}
          {shown.length === 0 && (
            <p className="afp-none">No field matches “{q}”.</p>
          )}
        </dl>
      )}
    </>
  );
}

// ── Order-mode segment button ────────────────────────────────────────────────

function OrderButton({
  mode,
  current,
  onSelect,
  children,
}: {
  mode: OrderMode;
  current: OrderMode;
  onSelect: (m: OrderMode) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`seg-btn${current === mode ? ' is-on' : ''}`}
      aria-pressed={current === mode}
      onClick={() => onSelect(mode)}
    >
      {children}
    </button>
  );
}

// ── Long text: a 2-line preview that clicks open ─────────────────────────────
// Clicking the text (or "View all") expands it; editing stays on the pencil so
// a click can never accidentally start an edit on a paragraph.

function LongTextValue({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);

  const canToggle = clamped || open;

  return (
    <span className="afp-val afp-longwrap">
      <span
        ref={ref}
        className={`afp-long${open ? '' : ' is-clamped'}${canToggle ? ' can-toggle' : ''}`}
        title={!open && clamped ? 'Click to view all' : undefined}
        onClick={canToggle ? () => setOpen((v) => !v) : undefined}
      >
        {text}
      </span>
      {canToggle && (
        <button type="button" className="linkbtn afp-more" onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : 'View all'}
        </button>
      )}
    </span>
  );
}

// ── Per-field history drawer ─────────────────────────────────────────────────

function FieldHistory({ woId, field }: { woId: string; field: WoFieldDescriptor }) {
  const historyQuery = useQuery({
    queryKey: ['wo-field-history', woId, field.key],
    queryFn: () => getFieldHistory(woId, field.key),
    retry: 0,
  });

  if (historyQuery.isLoading) {
    return <div className="afp-history"><span className="afp-none">Loading history…</span></div>;
  }
  if (historyQuery.isError) {
    const err = historyQuery.error;
    const forbidden = err instanceof ApiRequestError && err.status === 403;
    return (
      <div className="afp-history">
        <span className="afp-none">
          {forbidden ? 'Your role cannot view field history.' : 'History unavailable.'}
        </span>
      </div>
    );
  }

  const items = historyQuery.data?.items ?? [];
  if (items.length === 0) {
    return (
      <div className="afp-history">
        <span className="afp-none">No recorded changes — this value has held since import.</span>
      </div>
    );
  }

  return (
    <ol className="afp-history">
      {items.map((e: ActivityEntry) => {
        const who = e.actor?.display_name ?? 'System';
        const before = formatValue(unwrap(e.before), field);
        const after = formatValue(unwrap(e.after), field);
        return (
          <li key={e.id} className="afp-hrow">
            <span className={`audit-av${e.actor?.kind === 'service' ? ' is-service' : ''}`} aria-hidden="true">
              {initials(who)}
            </span>
            <p className="afp-htext">
              <b>{who}</b>{' '}
              {before === DASH && after !== DASH ? (
                <>set it to <span className="audit-val">{after}</span></>
              ) : after === DASH && before !== DASH ? (
                <>cleared it (was <span className="audit-val">{before}</span>)</>
              ) : (
                <>changed it from <span className="audit-val">{before}</span> to{' '}
                  <span className="audit-val">{after}</span></>
              )}
            </p>
            <time className="audit-time" dateTime={e.created_at}>{feedTime(e.created_at)}</time>
          </li>
        );
      })}
    </ol>
  );
}

