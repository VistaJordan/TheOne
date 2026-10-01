/* 0058 · The tools around the Vendors list: editing or removing a selection,
   pasting a column of names / phones / emails to see what is on file, and
   saving the current filters as a named list. */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { US_STATE_CODES } from '@theone/shared';
import type { SavedViewVisibility, VendorBulkPatch, VendorsMetaResponse } from '@theone/shared';
import {
  ApiRequestError,
  bulkDeleteVendors,
  bulkSearchVendors,
  bulkUpdateVendors,
  saveVendorView,
} from '../../api/client';
import type { BulkSearchResult } from '../../api/client';
import { ConfirmDialog } from '../ConfirmDialog';
import { useEscape } from '../../lib/useEscape';
import { Icon } from '../Icon';

const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : fallback);

// ── The bar that appears over the table once something is ticked ─────────────

export function BulkBar({ ids, meta, total, allMatching, onSelectAll, onClear, onDone }: {
  ids: string[];
  meta: VendorsMetaResponse | undefined;
  /** How many records the filters match in all. */
  total: number;
  allMatching: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onDone: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['vendors'] });
    void qc.invalidateQueries({ queryKey: ['vendors-meta'] });
  };
  const remove = useMutation({
    mutationFn: () => bulkDeleteVendors(ids),
    onSuccess: (r) => {
      refresh();
      setConfirm(false);
      onDone(`${r.removed} removed${r.skipped ? ` · ${r.skipped} left alone (outside what you can see)` : ''}`);
    },
  });

  return (
    <div className="vend-bulk" role="region" aria-label="Selection">
      <b>{ids.length} selected</b>
      {!allMatching && total > ids.length && (
        <button type="button" className="link-btn" onClick={onSelectAll}>
          Select all {total} that match
        </button>
      )}
      <span className="push" />
      {meta?.can.edit && (
        <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
          <Icon name="pencil" size={12} />
          Edit
        </button>
      )}
      {meta?.can.delete && (
        <button type="button" className="btn btn-sm is-danger" onClick={() => setConfirm(true)}>
          <Icon name="trash" size={12} />
          Remove
        </button>
      )}
      <button type="button" className="btn btn-sm is-ghost" onClick={onClear}>
        Clear
      </button>

      {editing && meta && (
        <BulkEditDialog
          ids={ids}
          meta={meta}
          onClose={() => setEditing(false)}
          onDone={(m) => {
            setEditing(false);
            refresh();
            onDone(m);
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={`Remove ${ids.length} ${ids.length === 1 ? 'vendor' : 'vendors'}?`}
          message={<>They leave the list and the maps. Their payments, bills and visits keep pointing at them, and each removal is in the audit log.</>}
          confirmLabel="Remove"
          danger
          busy={remove.isPending}
          busyLabel="Removing…"
          onCancel={() => setConfirm(false)}
          onConfirm={() => remove.mutate()}
        />
      )}
    </div>
  );
}

type BulkField = keyof VendorBulkPatch;

const BULK_FIELDS: { key: BulkField; label: string }[] = [
  { key: 'status', label: 'Status' },
  { key: 'owner_id', label: 'Owner' },
  { key: 'primary_trade', label: 'Primary trade' },
  { key: 'state', label: 'State' },
  { key: 'city', label: 'City' },
  { key: 'brand_source', label: 'Brand source' },
];

function BulkEditDialog({ ids, meta, onClose, onDone }: {
  ids: string[];
  meta: VendorsMetaResponse;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  useEscape(onClose);
  const [field, setField] = useState<BulkField>('status');
  const [value, setValue] = useState('');
  const save = useMutation({
    mutationFn: () => {
      const v: string | null = field === 'owner_id' && value === 'none' ? null : value;
      return bulkUpdateVendors(ids, { [field]: v } as VendorBulkPatch);
    },
    onSuccess: (r) => onDone(`${r.updated} updated${r.skipped ? ` · ${r.skipped} left alone (outside what you can see)` : ''}`),
  });

  const options: { value: string; label: string }[] | null =
    field === 'status'
      ? meta.statuses.filter((s) => s.is_active).map((s) => ({ value: s.key, label: s.label }))
      : field === 'owner_id'
        ? [{ value: 'none', label: 'No owner' }, ...meta.owners.map((o) => ({ value: o.id, label: o.name }))]
        : field === 'primary_trade'
          ? meta.trades.map((t) => ({ value: t, label: t }))
          : field === 'state'
            ? US_STATE_CODES.map((s) => ({ value: s, label: s }))
            : field === 'brand_source'
              ? meta.brand_sources.filter((b) => b.is_active).map((b) => ({ value: b.key, label: b.label }))
              : null;

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="bulkT" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="sheet vend-sheet">
        <h2 className="sheet-t" id="bulkT">
          <Icon name="pencil" size={18} />
          Edit {ids.length} {ids.length === 1 ? 'vendor' : 'vendors'}
        </h2>
        <p className="sheet-b">One field at a time. Each record is changed and logged exactly as if you had edited it by hand.</p>
        <div className="vend-form">
          <div className="field">
            <label className="lbl" htmlFor="bulk-field">Change</label>
            <select className="fld" id="bulk-field" value={field} onChange={(e) => { setField(e.target.value as BulkField); setValue(''); }}>
              {BULK_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="lbl" htmlFor="bulk-value">To</label>
            {options ? (
              <select className="fld" id="bulk-value" value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="">Choose…</option>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input className="fld" id="bulk-value" value={value} onChange={(e) => setValue(e.target.value)} />
            )}
          </div>
        </div>
        {save.isError && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{errText(save.error, 'Could not apply the change.')}</p>}
        <div className="sheet-f">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={value.trim() === '' || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Applying…' : `Apply to ${ids.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Paste a column, see what is on file ──────────────────────────────────────

export function BulkSearchDialog({ onClose, onShow }: { onClose: () => void; onShow: (ids: string[]) => void }) {
  useEscape(onClose);
  const [field, setField] = useState<'phone' | 'name' | 'email'>('phone');
  const [text, setText] = useState('');
  const [results, setResults] = useState<BulkSearchResult[] | null>(null);
  const terms = text.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  const run = useMutation({
    mutationFn: () => bulkSearchVendors(field, terms.slice(0, 300)),
    onSuccess: (r) => setResults(r.results),
  });
  const found = results?.filter((r) => r.matches.length > 0) ?? [];
  const missing = results?.filter((r) => r.matches.length === 0) ?? [];
  const ids = [...new Set(found.flatMap((r) => r.matches.map((m) => m.id)))];

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="bsT" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="sheet vend-sheet is-wide">
        <h2 className="sheet-t" id="bsT">
          <Icon name="search" size={18} />
          Look up a list
        </h2>
        <p className="sheet-b">Paste a column from a spreadsheet — one per line, up to 300 — to see which are already on file.</p>
        <div className="seg" role="group" aria-label="What the list holds">
          {(['phone', 'name', 'email'] as const).map((f) => (
            <button key={f} type="button" className={`seg-btn${field === f ? ' is-on' : ''}`} aria-pressed={field === f} onClick={() => { setField(f); setResults(null); }}>
              {f === 'phone' ? 'Phone numbers' : f === 'name' ? 'Names' : 'Emails'}
            </button>
          ))}
        </div>
        <textarea className="fld vend-paste" rows={7} value={text} placeholder={field === 'phone' ? '(409) 555-0143\n713-555-0188' : field === 'name' ? 'Bayou Mechanical\nGulf Coast Refrigeration' : 'ops@example.com'} onChange={(e) => { setText(e.target.value); setResults(null); }} aria-label="The list" />
        {run.isError && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{errText(run.error, 'Could not look the list up.')}</p>}
        {results && (
          <div className="vend-bs">
            <p>
              <b>{found.length}</b> on file · <b>{missing.length}</b> not found
            </p>
            {found.length > 0 && (
              <ul>
                {found.slice(0, 80).map((r) => (
                  <li key={r.term}>
                    <span className="mono">{r.term}</span>
                    <Icon name="arrow-r" size={12} />
                    {r.matches.map((m) => <Link key={m.id} to={`/vendors/${m.id}`} target="_blank" rel="noreferrer">{m.name}</Link>)}
                  </li>
                ))}
              </ul>
            )}
            {missing.length > 0 && (
              <>
                <p className="overline">Not on file</p>
                <p className="mono vend-bs-missing">{missing.map((r) => r.term).join('\n')}</p>
              </>
            )}
          </div>
        )}
        <div className="sheet-f">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          {results && ids.length > 0 && (
            <button type="button" className="btn" onClick={() => onShow(ids)}>
              Show the {ids.length} in the list
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={terms.length === 0 || run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'Looking…' : `Look up ${terms.length || ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Save the current filters as a list ───────────────────────────────────────

export function SaveViewDialog({ params, canShare, onClose }: { params: Record<string, string>; canShare: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  useEscape(onClose);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<SavedViewVisibility>('PRIVATE');
  const save = useMutation({
    mutationFn: () => saveVendorView({ name: name.trim(), params, visibility }),
    onSuccess: (r) => {
      qc.setQueryData(['vendor-views'], r);
      onClose();
    },
  });
  const what = Object.entries(params).filter(([k]) => k !== 'sort' && k !== 'dir');
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="svT" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="sheet vend-sheet">
        <h2 className="sheet-t" id="svT">
          <Icon name="list" size={18} />
          Save this list
        </h2>
        <p className="sheet-b">
          {what.length === 0 ? 'No filters are on — this saves the whole list.' : `Saves: ${what.map(([k, v]) => `${k} = ${v}`).join(' · ')}`}
        </p>
        <div className="vend-form">
          <div className="field">
            <label className="lbl" htmlFor="sv-name">Name</label>
            <input className="fld" id="sv-name" autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label className="lbl" htmlFor="sv-vis">Who sees it</label>
            <select className="fld" id="sv-vis" value={visibility} onChange={(e) => setVisibility(e.target.value as SavedViewVisibility)}>
              <option value="PRIVATE">Only me</option>
              {canShare && <option value="MANAGERS">Managers</option>}
              <option value="EVERYONE">Everyone with the Vendors section</option>
            </select>
          </div>
        </div>
        {save.isError && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{errText(save.error, 'Could not save the list.')}</p>}
        <div className="sheet-f">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={name.trim() === '' || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save list'}
          </button>
        </div>
      </div>
    </div>
  );
}
