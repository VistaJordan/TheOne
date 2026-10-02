/* /assets/:id — one asset (0060): what it is, where it stands, its warranty,
 * what it is part of and what is part of it, every condition reading, and its
 * service history — the work orders raised against it. */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ASSET_CONDITIONS, ASSET_CONDITION_LABELS, SITE_SOURCE_LABELS, WARRANTY_STATE_LABELS } from '@theone/shared';
import type { AssetCondition } from '@theone/shared';
import { deleteAsset, getAsset, getAssetHistory, getSitesMeta, listAssetRequests, recordAssetCondition } from '../api/client';
import { AssetRequestDialog, AssetRequestsTab } from '../components/portfolio/AssetRequests';
import { AppShell } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import {
  AssetFormDialog,
  AssetStatusChip,
  ConditionChip,
  HistoryCard,
  WarrantyChip,
  WorkOrderList,
  day,
  errText,
} from '../components/portfolio/PortfolioParts';
import { feedTime } from '../lib/fields';

export function AssetDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const key = ['asset', id];
  const q = useQuery({ queryKey: key, queryFn: () => getAsset(id) });
  const meta = useQuery({ queryKey: ['sites-meta'], queryFn: getSitesMeta });
  const a = q.data?.asset ?? null;
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [requesting, setRequesting] = useState(false);
  // 0061 — the requests raised about this asset (or that created it).
  const requests = useQuery({ queryKey: ['asset-requests', 'all', id], queryFn: () => listAssetRequests({ status: 'all', asset: id }) });
  const [problem, setProblem] = useState<string | null>(null);
  const [reading, setReading] = useState<{ condition: AssetCondition; note: string; wo: string } | null>(null);

  const remove = useMutation({
    mutationFn: () => deleteAsset(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['assets'] });
      void qc.invalidateQueries({ queryKey: ['site'] });
      void qc.invalidateQueries({ queryKey: ['sites-meta'] });
      navigate(a?.site ? `/sites/${a.site.id}` : '/assets');
    },
    onError: (e) => setProblem(errText(e, 'Could not remove the asset.')),
  });
  const record = useMutation({
    mutationFn: () => recordAssetCondition(id, { condition: reading!.condition, note: reading!.note.trim() || null, wo_number: reading!.wo.trim() || null }),
    onSuccess: (res) => {
      qc.setQueryData(key, res);
      void qc.invalidateQueries({ queryKey: ['assets'] });
      void qc.invalidateQueries({ queryKey: ['site'] });
      setReading(null);
      setProblem(null);
    },
    onError: (e) => setProblem(errText(e, 'Could not record the condition.')),
  });

  const crumbs = (
    <nav className="crumbs" aria-label="Breadcrumb">
      <button type="button" className="crumb-back" aria-label="Back to Assets" onClick={() => navigate('/assets')}><Icon name="arrow-l" size={14} /></button>
      <Link className="crumb" to="/assets">Assets</Link>
      <span className="crumb-sep" aria-hidden="true">/</span>
      <span className="crumb-cur" aria-current="page">{a?.name ?? '…'}</span>
    </nav>
  );
  const shell = (children: ReactNode) => (
    <AppShell active="Assets" breadcrumb={crumbs}>
      <div className="canvas-inner">{children}</div>
    </AppShell>
  );
  if (q.isLoading) return shell(<div className="wo-state"><b>Loading the asset…</b></div>);
  if (q.isError || !a) {
    return shell(
      <div className="wo-state">
        <Icon name="alert" size={22} />
        <b>Could not open this asset</b>
        <span>{errText(q.error, 'It may have been removed.')}</span>
        <Link className="btn" to="/assets">Back to Assets</Link>
      </div>,
    );
  }

  const rows: [string, ReactNode][] = [
    ['Site', a.site ? <Link to={`/sites/${a.site.id}`}>{a.site.name}</Link> : null],
    ['Where it stands', a.location],
    ['Category', a.category],
    ['Type', a.asset_type],
    ['Manufacturer', a.manufacturer],
    ['Model', a.model_number],
    ['Serial number', a.serial_number],
    ['Asset tag', a.asset_tag],
    ['Installed on', a.install_date ? day(a.install_date) : null],
    ['Part of', a.parent ? <Link to={`/assets/${a.parent.id}`}>{a.parent.name}</Link> : null],
    ['Description', [a.description, a.alt_description].filter(Boolean).join(' — ') || null],
    ['Notes', a.notes],
  ];

  return shell(
    <>
      <section className="card vrec-head">
        <div className="vrec-title">
          <h1>{a.name}</h1>
          <div className="vrec-chips">
            <AssetStatusChip status={a.status} />
            <ConditionChip condition={a.condition} />
            <WarrantyChip state={a.warranty} expiresOn={a.warranty_expires_on} />
            <span className="chip chip-sm">{SITE_SOURCE_LABELS[a.source] ?? a.source}</span>
            <span className="chip chip-sm">{a.open_work_orders} open · {a.work_orders} work orders</span>
          </div>
        </div>
        <div className="vrec-actions">
          {requests.data?.can.create && a.status !== 'retired' && (
            <button type="button" className="btn" onClick={() => setRequesting(true)}>
              <Icon name="inbox" size={14} />
              Request a change
            </button>
          )}
          {a.can.edit && (
            <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>
              <Icon name="pencil" size={14} />
              Edit
            </button>
          )}
          {a.can.delete && (
            <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" size={14} />
              Remove
            </button>
          )}
        </div>
      </section>
      {problem && <div className="callout" style={{ marginTop: 12 }}><Icon name="alert" size={14} /><span>{problem}</span></div>}

      <div className="vrec-grid">
        <div className="vrec-col">
          <section className="card">
            <div className="card-head"><h2 className="card-title">The asset</h2></div>
            <div className="vrec-fields">
              {rows.map(([label, value]) => (
                <div className={`vrec-field${label === 'Description' || label === 'Notes' ? ' is-wide' : ''}`} key={label}>
                  <span className="lbl">{label}</span>
                  <span className={`vrec-val${value ? '' : ' is-none'}`}>{value || '—'}</span>
                </div>
              ))}
            </div>
          </section>

          {a.children.length > 0 && (
            <section className="card">
              <div className="card-head"><h2 className="card-title grow">Parts of this asset</h2><span className="card-meta">{a.children.length}</span></div>
              <ul className="vrec-list">
                {a.children.map((c) => (
                  <li key={c.id}>
                    <Link to={`/assets/${c.id}`}>{c.name}</Link>
                    {c.asset_type && <span>{c.asset_type}</span>}
                    <span className="push"><AssetStatusChip status={c.status} /></span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {requests.data && requests.data.requests.length > 0 && (
            <section className="card">
              <div className="card-head"><h2 className="card-title">Requests about this asset</h2></div>
              <AssetRequestsTab meta={meta.data} assetId={id} />
            </section>
          )}

          <section className="card">
            <div className="card-head">
              <h2 className="card-title grow">Service history</h2>
              <span className="card-meta">{a.work_orders}{a.work_orders > a.service_history.length ? ` · latest ${a.service_history.length}` : ''}</span>
            </div>
            <WorkOrderList items={a.service_history} empty="No work order has been raised against this asset." />
          </section>
        </div>

        <aside className="vrec-col">
          <section className="card">
            <div className="card-head"><h2 className="card-title">Warranty</h2></div>
            <div className="vrec-fields pf-one">
              <div className="vrec-field">
                <span className="lbl">Stands</span>
                <span className="vrec-val">{WARRANTY_STATE_LABELS[a.warranty]}</span>
              </div>
              <div className="vrec-field">
                <span className="lbl">Ends</span>
                <span className={`vrec-val${a.warranty_expires_on ? '' : ' is-none'}`}>{a.warranty_expires_on ? day(a.warranty_expires_on) : '—'}</span>
              </div>
              <div className="vrec-field">
                <span className="lbl">With</span>
                <span className={`vrec-val${a.warranty_provider ? '' : ' is-none'}`}>{a.warranty_provider ?? '—'}</span>
              </div>
              {a.warranty_notes && (
                <div className="vrec-field">
                  <span className="lbl">Covers</span>
                  <span className="vrec-val">{a.warranty_notes}</span>
                </div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title grow">Condition</h2>
              {a.can.edit && reading === null && (
                <button type="button" className="btn btn-sm is-ghost" onClick={() => setReading({ condition: a.condition ?? 'good', note: '', wo: '' })}>
                  <Icon name="plus" size={12} /> Record a reading
                </button>
              )}
            </div>
            {reading !== null && (
              <div className="vrec-form">
                <div className="seg" role="group" aria-label="Condition">
                  {ASSET_CONDITIONS.map((c) => (
                    <button key={c} type="button" className={`seg-btn${reading.condition === c ? ' is-on' : ''}`} aria-pressed={reading.condition === c} onClick={() => setReading({ ...reading, condition: c })}>
                      {ASSET_CONDITION_LABELS[c]}
                    </button>
                  ))}
                </div>
                <textarea className="fld" rows={2} placeholder="What was seen (optional)" value={reading.note} onChange={(e) => setReading({ ...reading, note: e.target.value })} aria-label="Note" />
                <input className="fld mono" placeholder="Work order it was seen on, e.g. WO-39403 (optional)" value={reading.wo} onChange={(e) => setReading({ ...reading, wo: e.target.value })} aria-label="Work order" />
                <span style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn btn-sm" disabled={record.isPending} onClick={() => record.mutate()}>Record</button>
                  <button type="button" className="btn btn-sm is-ghost" onClick={() => setReading(null)}>Cancel</button>
                </span>
              </div>
            )}
            <ul className="vrec-list vrec-log">
              {a.condition_log.length === 0 && reading === null && <li>No reading recorded yet.</li>}
              {a.condition_log.map((c) => (
                <li key={c.id}>
                  <span className="vrec-log-h">
                    <ConditionChip condition={c.condition} />
                    <span className="vrec-sub">{[c.recorded_by?.name, feedTime(c.recorded_at)].filter(Boolean).join(' · ')}</span>
                    {c.wo_number && <Link className="push" to={`/work-orders/${encodeURIComponent(c.wo_number)}`}>{c.wo_number}</Link>}
                  </span>
                  {c.note && <span className="vrec-log-n">{c.note}</span>}
                </li>
              ))}
            </ul>
          </section>

          <HistoryCard queryKey={['asset-history', id, a.updated_at]} load={() => getAssetHistory(id)} />
        </aside>
      </div>

      {editing && <AssetFormDialog asset={a} meta={meta.data} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
      {requesting && (
        <AssetRequestDialog
          asset={a}
          meta={meta.data}
          onClose={() => setRequesting(false)}
          onDone={() => { setRequesting(false); void qc.invalidateQueries({ queryKey: ['asset-requests'] }); }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={`Remove ${a.name}?`}
          message={<>It leaves the lists. Its {a.work_orders} work {a.work_orders === 1 ? 'order keeps' : 'orders keep'} pointing at it and the change history stays.{a.children.length > 0 ? ' Its parts stay on file as assets of their own.' : ''}</>}
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { setConfirmDelete(false); remove.mutate(); }}
        />
      )}
    </>,
  );
}
