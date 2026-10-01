/* 0059 · Three more ways to look at the Vendors list.
 *
 *   AdvancedFilterDialog  rules joined by "all of" or "any of", on any field in
 *                         shared/vendorFilters.ts. The result travels as the
 *                         `filter` query parameter, so a saved list, the
 *                         export and "select all that match" all honour it.
 *   ColumnsDialog         which columns the table draws — kept per account.
 *   VendorBoard           the same rows as cards under their status; dragging
 *                         a card (or its "Move to" menu) changes the status,
 *                         through the ordinary vendor edit, so it is logged
 *                         and the usual rules apply.
 */

import { useState } from 'react';
import type { DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COMPLIANCE_STATUS_LABELS,
  VENDOR_BOARD_COLUMN_LIMIT,
  VENDOR_COLUMNS,
  VENDOR_DEFAULT_COLUMNS,
  VENDOR_FILTER_FIELDS,
  VENDOR_FILTER_MAX_RULES,
  VENDOR_FILTER_OPS,
  VENDOR_FILTER_OP_LABELS,
  VENDOR_FILTER_VALUELESS,
  VENDOR_KIND_LABELS,
  cleanVendorFilter,
} from '@theone/shared';
import type {
  VendorFilter,
  VendorFilterField,
  VendorFilterOp,
  VendorFilterRule,
  VendorRow,
  VendorStatusDef,
  VendorsMetaResponse,
} from '@theone/shared';
import { ApiRequestError, getVendorBoard, updateVendor } from '../../api/client';
import type { VendorListParams } from '../../api/client';
import { useEscape } from '../../lib/useEscape';
import { Icon } from '../Icon';

const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : fallback);

// ═══ Advanced filters ════════════════════════════════════════════════════════

function optionsFor(def: VendorFilterField, meta: VendorsMetaResponse | undefined): { value: string; label: string }[] | null {
  if (def.options) return def.options;
  switch (def.dynamic) {
    case 'status': return (meta?.statuses ?? []).map((s) => ({ value: s.key, label: s.label }));
    case 'brand_source': return (meta?.brand_sources ?? []).map((b) => ({ value: b.key, label: b.label }));
    case 'owner': return (meta?.owners ?? []).map((o) => ({ value: o.id, label: o.name }));
    case 'trade': return (meta?.trades ?? []).map((t) => ({ value: t, label: t }));
    default: return null;
  }
}

/** How a filter reads in one line, for the chip on the list. */
export function describeVendorFilter(f: VendorFilter, meta: VendorsMetaResponse | undefined): string {
  const parts = f.rules.map((r) => {
    const def = VENDOR_FILTER_FIELDS.find((x) => x.key === r.field);
    if (!def) return '';
    const opts = optionsFor(def, meta);
    const shown = r.value === undefined ? '' : ` ${opts?.find((o) => o.value === r.value)?.label ?? r.value}`;
    return `${def.label} ${VENDOR_FILTER_OP_LABELS[r.op]}${shown}`;
  });
  return parts.filter(Boolean).join(f.join === 'or' ? '  or  ' : '  and  ');
}

type DraftRule = { field: string; op: VendorFilterOp; value: string };
const blankRule = (): DraftRule => ({ field: 'name', op: 'contains', value: '' });

export function AdvancedFilterDialog({ initial, meta, onApply, onClose }: {
  initial: VendorFilter | null;
  meta: VendorsMetaResponse | undefined;
  onApply: (f: VendorFilter | null) => void;
  onClose: () => void;
}) {
  useEscape(onClose);
  const [join, setJoin] = useState<'and' | 'or'>(initial?.join ?? 'and');
  const [rules, setRules] = useState<DraftRule[]>(
    initial && initial.rules.length > 0 ? initial.rules.map((r) => ({ field: r.field, op: r.op, value: r.value ?? '' })) : [blankRule()],
  );
  const patch = (i: number, p: Partial<DraftRule>) => setRules((cur) => cur.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const setField = (i: number, key: string) => {
    const def = VENDOR_FILTER_FIELDS.find((f) => f.key === key)!;
    patch(i, { field: key, op: VENDOR_FILTER_OPS[def.type][0], value: '' });
  };
  const usable = cleanVendorFilter({ join, rules: rules as VendorFilterRule[] });
  const complete = usable?.rules.length ?? 0;

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="afT" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="sheet vend-sheet is-wide vflt">
        <h2 className="sheet-t" id="afT">
          <Icon name="filter" size={16} />
          Filters
        </h2>
        <div className="vflt-join">
          <span>Show vendors that match</span>
          <div className="seg" role="group" aria-label="How the rules combine">
            <button type="button" className={`seg-btn${join === 'and' ? ' is-on' : ''}`} aria-pressed={join === 'and'} onClick={() => setJoin('and')}>all of these</button>
            <button type="button" className={`seg-btn${join === 'or' ? ' is-on' : ''}`} aria-pressed={join === 'or'} onClick={() => setJoin('or')}>any of these</button>
          </div>
        </div>
        <div className="vflt-rules">
          {rules.map((r, i) => {
            const def = VENDOR_FILTER_FIELDS.find((f) => f.key === r.field) ?? VENDOR_FILTER_FIELDS[0];
            const opts = optionsFor(def, meta);
            const noValue = VENDOR_FILTER_VALUELESS.includes(r.op);
            return (
              <div className="vflt-rule" key={i}>
                <span className="vflt-word">{i === 0 ? 'Where' : join === 'or' ? 'or' : 'and'}</span>
                <select className="fld" value={r.field} onChange={(e) => setField(i, e.target.value)} aria-label="Field">
                  {VENDOR_FILTER_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
                <select className="fld" value={r.op} onChange={(e) => patch(i, { op: e.target.value as VendorFilterOp })} aria-label="Condition">
                  {VENDOR_FILTER_OPS[def.type].map((o) => <option key={o} value={o}>{VENDOR_FILTER_OP_LABELS[o]}</option>)}
                </select>
                {noValue ? (
                  <span />
                ) : opts && (def.type === 'choice' || def.type === 'list') ? (
                  <select className="fld" value={r.value} onChange={(e) => patch(i, { value: e.target.value })} aria-label="Value">
                    <option value="">Choose…</option>
                    {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <input
                    className="fld"
                    type={def.type === 'date' ? 'date' : def.type === 'number' ? 'number' : 'text'}
                    value={r.value}
                    onChange={(e) => patch(i, { value: e.target.value })}
                    aria-label="Value"
                  />
                )}
                <button type="button" className="icon-btn" aria-label="Remove this rule" onClick={() => setRules((cur) => (cur.length === 1 ? [blankRule()] : cur.filter((_, j) => j !== i)))}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <div>
          <button type="button" className="btn btn-sm is-ghost" disabled={rules.length >= VENDOR_FILTER_MAX_RULES} onClick={() => setRules((cur) => [...cur, blankRule()])}>
            <Icon name="plus" size={12} /> Add a rule
          </button>
        </div>
        <p className="hint">These work together with the dropdowns above the list. A rule with no value is ignored.</p>
        <div className="sheet-f">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {initial && <button type="button" className="btn" onClick={() => onApply(null)}>Clear filters</button>}
          <button type="button" className="btn btn-primary" onClick={() => onApply(usable)}>
            {complete === 0 ? 'Apply' : `Apply ${complete} ${complete === 1 ? 'rule' : 'rules'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══ Columns ═════════════════════════════════════════════════════════════════

export function ColumnsDialog({ shown, onSave, onClose }: { shown: string[]; onSave: (cols: string[]) => void; onClose: () => void }) {
  useEscape(onClose);
  const [on, setOn] = useState<Set<string>>(new Set(shown));
  const toggle = (k: string) => setOn((cur) => {
    const next = new Set(cur);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    return next;
  });
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="colT" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="sheet vend-sheet">
        <h2 className="sheet-t" id="colT">
          <Icon name="columns" size={16} />
          Columns
        </h2>
        <p className="sheet-b">Tick what the list should show. Name is always there. Your choice is kept for you on every device.</p>
        <div className="vcols">
          {VENDOR_COLUMNS.map((c) => (
            <label key={c.key} className="tmap-check">
              <input type="checkbox" checked={on.has(c.key)} onChange={() => toggle(c.key)} />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
        <div className="sheet-f">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" onClick={() => setOn(new Set(VENDOR_DEFAULT_COLUMNS))}>Reset</button>
          <button type="button" className="btn btn-primary" disabled={on.size === 0} onClick={() => onSave(VENDOR_COLUMNS.filter((c) => on.has(c.key)).map((c) => c.key))}>
            Show {on.size} {on.size === 1 ? 'column' : 'columns'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══ The board ═══════════════════════════════════════════════════════════════

export function VendorBoard({ params, statuses, canEdit, onSeeAll }: {
  params: VendorListParams;
  statuses: VendorStatusDef[];
  canEdit: boolean;
  /** Open the list narrowed to one status. */
  onSeeAll: (status: string) => void;
}) {
  const qc = useQueryClient();
  const key = ['vendor-board', params];
  const q = useQuery({ queryKey: key, queryFn: () => getVendorBoard(params), placeholderData: keepPreviousData });
  const [dragging, setDragging] = useState<{ id: string; from: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const move = useMutation({
    mutationFn: (x: { id: string; status: string }) => updateVendor(x.id, { status: x.status }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ['vendor-board'] });
      void qc.invalidateQueries({ queryKey: ['vendors'] });
    },
    onError: (e) => setError(errText(e, 'Could not move the vendor.')),
  });

  const labelOf = (k: string) => statuses.find((s) => s.key === k)?.label ?? k;
  const colorOf = (k: string) => statuses.find((s) => s.key === k)?.color ?? 'slate';
  const drop = (e: DragEvent, status: string) => {
    e.preventDefault();
    setOver(null);
    if (dragging && dragging.from !== status) move.mutate({ id: dragging.id, status });
    setDragging(null);
  };

  if (q.isLoading) return <div className="empty-flat">Loading the board…</div>;
  if (q.isError || !q.data) return <div className="empty-flat">{errText(q.error, 'Could not load the board.')}</div>;
  const cols = q.data.columns;

  return (
    <>
      {error && (
        <div className="tmap-banner is-warn" role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
          <button type="button" className="icon-btn" onClick={() => setError(null)} aria-label="Dismiss"><Icon name="x" size={12} /></button>
        </div>
      )}
      <div className="vboard" aria-busy={q.isFetching || move.isPending}>
        {cols.map((c) => (
          <section
            key={c.status}
            className={`vboard-col${over === c.status && dragging?.from !== c.status ? ' is-over' : ''}`}
            onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(c.status); } }}
            onDragLeave={() => setOver((cur) => (cur === c.status ? null : cur))}
            onDrop={(e) => drop(e, c.status)}
            aria-label={`${labelOf(c.status)}, ${c.total}`}
          >
            <header className="vboard-head">
              <span className={`vstatus is-${colorOf(c.status)}`}>{labelOf(c.status)}</span>
              <span className="vboard-n">{c.total}</span>
            </header>
            <div className="vboard-cards">
              {c.items.map((v) => (
                <BoardCard
                  key={v.id}
                  v={v}
                  statuses={statuses}
                  canEdit={canEdit}
                  busy={move.isPending}
                  onDragStart={() => setDragging({ id: v.id, from: c.status })}
                  onDragEnd={() => { setDragging(null); setOver(null); }}
                  onMove={(status) => move.mutate({ id: v.id, status })}
                />
              ))}
              {c.items.length === 0 && <p className="vboard-empty">{dragging ? 'Drop here' : 'None'}</p>}
              {c.total > c.items.length && (
                <button type="button" className="link-btn vboard-more" onClick={() => onSeeAll(c.status)}>
                  Showing the latest {VENDOR_BOARD_COLUMN_LIMIT} of {c.total} — see all in the list
                </button>
              )}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function BoardCard({ v, statuses, canEdit, busy, onDragStart, onDragEnd, onMove }: {
  v: VendorRow;
  statuses: VendorStatusDef[];
  canEdit: boolean;
  busy: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (status: string) => void;
}) {
  const where = [v.city, v.state].filter(Boolean).join(', ');
  return (
    <article
      className="vboard-card"
      draggable={canEdit}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', v.id); onDragStart(); }}
      onDragEnd={onDragEnd}
    >
      <Link className="vboard-name" to={`/vendors/${v.id}`} draggable={false}>{v.name}</Link>
      <span className="vboard-sub">{[v.primary_trade, where].filter(Boolean).join(' · ') || '—'}</span>
      {v.phone && <span className="vboard-sub mono">{v.phone}</span>}
      <span className="vboard-chips">
        <span className="chip chip-sm">{VENDOR_KIND_LABELS[v.kind]}</span>
        {v.kind === 'vendor' && <span className="chip chip-outline chip-sm">{COMPLIANCE_STATUS_LABELS[v.compliance_status]}</span>}
        {v.blacklisted && <span className="chip chip-danger chip-sm">Blacklisted</span>}
        {v.flagged_duplicate && <span className="chip chip-sm">Possible duplicate</span>}
        {v.flagged_missing && <span className="chip chip-sm">Missing information</span>}
      </span>
      <span className="vboard-foot">
        <span>{v.owner?.name ?? 'No owner'}</span>
        {canEdit && (
          <select className="fld vboard-move" value="" disabled={busy} onChange={(e) => { if (e.target.value) onMove(e.target.value); }} aria-label={`Move ${v.name} to another status`}>
            <option value="">Move to…</option>
            {statuses.filter((s) => s.is_active && s.key !== v.status).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        )}
      </span>
    </article>
  );
}
