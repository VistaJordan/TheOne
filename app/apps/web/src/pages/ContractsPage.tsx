/* /contracts — the rate cards (0046, Facilio's Contracts › Contract + Labor
   Rates in one place).

   A contract is the price a client has agreed: hourly, overtime, double
   time, trip charge, markup on parts, for a client (or all), one entity (or
   all), some sites and trades (or all), between two dates. The quote builder
   takes its overtime multiplier and default rates from the card that covers
   the work order; an invoice with no quote bills hours on site at its rate.

   One page: the list on the left with "in force" up top, the editor in a
   dialog. Deleting is allowed (quotes keep the multiplier they were priced
   with), but the list warns before it. */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONTRACT_KIND_LABELS,
  CONTRACT_KINDS,
  RATE_TYPES,
  RATE_TYPE_LABELS,
  RATE_TYPE_UNITS,
  type Contract,
  type ContractInput,
  type ContractKind,
  type ContractRateInput,
  type RateType,
} from '@theone/shared';
import { ApiRequestError, createContract, deleteContract, listContracts, updateContract } from '../api/client';
import { AppShell } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { useAuth } from '../auth/AuthProvider';
import { usd } from '../lib/quoteTotals';

export function ContractsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canView = can('contracts', 'view');
  const canCreate = can('contracts', 'create');
  const canEdit = can('contracts', 'edit');
  const canDelete = can('contracts', 'delete');

  const q = useQuery({ queryKey: ['contracts'], queryFn: listContracts, retry: 0, enabled: canView });
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const [editing, setEditing] = useState<Contract | 'new' | null>(null);
  const [removing, setRemoving] = useState<Contract | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lane, setLane] = useState<'force' | 'all'>('force');

  const shown = lane === 'force' ? items.filter((c) => c.in_force) : items;

  const done = () => {
    setError(null);
    setEditing(null);
    setRemoving(null);
    void qc.invalidateQueries({ queryKey: ['contracts'] });
  };
  const fail = (err: unknown) =>
    setError(err instanceof ApiRequestError ? err.message : 'That change did not save');
  const remove = useMutation({ mutationFn: (id: string) => deleteContract(id), onSuccess: done, onError: fail });

  if (!canView) {
    return (
      <AppShell active="Contracts">
        <div className="wo-state">
          <Icon name="lock" size={22} />
          <b>Contracts are not available to you</b>
          <span>Ask an admin for the "Contracts and rates" permission.</span>
        </div>
      </AppShell>
    );
  }

  const rateLine = (c: Contract) => {
    const pick = (t: RateType) => c.rates.find((r) => r.rate_type === t && r.trade === null)?.amount ?? null;
    const parts: string[] = [];
    const s = pick('standard');
    const o = pick('overtime');
    const trip = pick('trip_charge');
    const mk = pick('markup_pct');
    if (s !== null) parts.push(`${usd(s)}/h`);
    if (o !== null) parts.push(`OT ${usd(o)}/h`);
    if (trip !== null) parts.push(`trip ${usd(trip)}`);
    if (mk !== null) parts.push(`${mk}% on parts`);
    const perTrade = c.rates.filter((r) => r.trade !== null).length;
    if (perTrade > 0) parts.push(`${perTrade} trade rate${perTrade === 1 ? '' : 's'}`);
    return parts.length > 0 ? parts.join(' · ') : 'No rates yet';
  };

  return (
    <AppShell active="Contracts">
      <div className="page-head">
        <h1 className="page-title">Contracts and rates</h1>
        <p className="page-sub">
          What each client has agreed the work costs. A quote prices against the card that covers
          its work order; an invoice with no quote bills the hours on site at the card's rate.
        </p>
      </div>

      <div className="payq-head">
        <div className="seg payq-lanes" role="group" aria-label="Contracts">
          <button type="button" className={`seg-btn${lane === 'force' ? ' is-on' : ''}`} aria-pressed={lane === 'force'} onClick={() => setLane('force')}>
            In force <span className="payq-count">{items.filter((c) => c.in_force).length}</span>
          </button>
          <button type="button" className={`seg-btn${lane === 'all' ? ' is-on' : ''}`} aria-pressed={lane === 'all'} onClick={() => setLane('all')}>
            All <span className="payq-count">{items.length}</span>
          </button>
        </div>
        {canCreate && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> New contract
          </button>
        )}
      </div>

      {error && (
        <p className="payq-err" role="alert">
          <Icon name="alert-circle" size={14} /> {error}
        </p>
      )}

      <div className="table-wrap">
        <table className="ct">
          <thead>
            <tr>
              <th>Contract</th>
              <th>Client · Entity</th>
              <th>Covers</th>
              <th>Rates</th>
              <th className="col-date">From → to</th>
              <th className="rcv-action-th">Actions</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && <tr className="ct-empty"><td colSpan={6}>Loading contracts…</td></tr>}
            {q.isError && <tr className="ct-empty"><td colSpan={6}>Could not load contracts.</td></tr>}
            {!q.isLoading && !q.isError && shown.length === 0 && (
              <tr className="ct-empty">
                <td colSpan={6}>
                  {items.length === 0
                    ? 'No contracts yet. Add the first rate card to stop quotes pricing at the house ×1.5.'
                    : 'Nothing in force today.'}
                </td>
              </tr>
            )}
            {shown.map((c) => (
              <tr key={c.id} className={c.in_force ? undefined : 'is-muted'}>
                <td>
                  <div className="site">
                    <strong>{c.name}</strong>
                    <small>
                      {CONTRACT_KIND_LABELS[c.kind]}
                      {c.account_code ? ` · ${c.account_code}` : ''}
                      {!c.active ? ' · inactive' : !c.in_force ? ' · not in force' : ''}
                    </small>
                  </div>
                </td>
                <td>
                  <div className="site">
                    <strong>{c.client ?? 'Every client'}</strong>
                    <small>{c.billing_entity ?? 'Every entity'}</small>
                  </div>
                </td>
                <td className="rcv-trunc">
                  {c.trades_covered.length > 0 ? c.trades_covered.join(', ') : 'All trades'}
                  {c.sites_covered.length > 0 ? ` · ${c.sites_covered.length} site${c.sites_covered.length === 1 ? '' : 's'}` : ''}
                </td>
                <td className="rcv-trunc">{rateLine(c)}</td>
                <td className="col-date">
                  {c.starts_on} → {c.ends_on ?? 'open'}
                </td>
                <td className="rcv-action-td">
                  {canEdit && (
                    <button type="button" className="rcv-btn" onClick={() => setEditing(c)}>
                      <Icon name="pencil" size={12} /> Edit
                    </button>
                  )}
                  {canDelete && (
                    <button type="button" className="rcv-btn" onClick={() => setRemoving(c)} title="Delete this contract">
                      <Icon name="trash" size={12} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <ContractDialog
          contract={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={done}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={`Delete "${removing.name}"?`}
          message="Quotes already priced under it keep the multiplier they were priced with."
          note="New quotes for this client fall back to the next matching card, or the house rates."
          noteTone="info"
          confirmLabel="Delete contract"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing.id)}
          busy={remove.isPending}
        />
      )}
    </AppShell>
  );
}

interface DraftRate {
  key: number;
  rate_type: RateType;
  trade: string;
  amount: string;
}

let seq = 0;

function ContractDialog({
  contract,
  onClose,
  onSaved,
}: {
  contract: Contract | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(contract?.name ?? '');
  const [client, setClient] = useState(contract?.client ?? '');
  const [entity, setEntity] = useState(contract?.billing_entity ?? '');
  const [kind, setKind] = useState<ContractKind>(contract?.kind ?? 'tm');
  const [account, setAccount] = useState(contract?.account_code ?? '');
  const [startsOn, setStartsOn] = useState(contract?.starts_on ?? new Date().toISOString().slice(0, 10));
  const [endsOn, setEndsOn] = useState(contract?.ends_on ?? '');
  const [active, setActive] = useState(contract?.active ?? true);
  const [sites, setSites] = useState((contract?.sites_covered ?? []).join(', '));
  const [trades, setTrades] = useState((contract?.trades_covered ?? []).join(', '));
  const [notes, setNotes] = useState(contract?.notes ?? '');
  const [rates, setRates] = useState<DraftRate[]>(
    contract && contract.rates.length > 0
      ? contract.rates.map((r) => ({ key: ++seq, rate_type: r.rate_type, trade: r.trade ?? '', amount: String(r.amount) }))
      : [
          { key: ++seq, rate_type: 'standard', trade: '', amount: '' },
          { key: ++seq, rate_type: 'overtime', trade: '', amount: '' },
          { key: ++seq, rate_type: 'trip_charge', trade: '', amount: '' },
        ],
  );
  const [error, setError] = useState<string | null>(null);

  const list = (s: string) => s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  const input = (): ContractInput => ({
    name: name.trim(),
    client: client.trim() || null,
    billing_entity: entity.trim() || null,
    kind,
    account_code: account.trim() || null,
    starts_on: startsOn,
    ends_on: endsOn || null,
    active,
    sites_covered: list(sites),
    trades_covered: list(trades),
    notes: notes.trim() || null,
    rates: rates
      .filter((r) => r.amount.trim() !== '' && Number.isFinite(Number(r.amount)))
      .map((r): ContractRateInput => ({ rate_type: r.rate_type, trade: r.trade.trim() || null, amount: Number(r.amount) })),
  });

  const save = useMutation({
    mutationFn: () => (contract ? updateContract(contract.id, input()) : createContract(input())),
    onSuccess: onSaved,
    onError: (err: unknown) => setError(err instanceof ApiRequestError ? err.message : 'The contract did not save'),
  });

  const setRate = (i: number, patch: Partial<DraftRate>) =>
    setRates(rates.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const missing = name.trim() === '' ? 'a name' : null;

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label={contract ? 'Edit contract' : 'New contract'} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{contract ? 'Edit contract' : 'New contract'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="intake-grid">
            <div className="field intake-wide">
              <label className="lbl" htmlFor="c-name">Name</label>
              <input id="c-name" className="fld" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Wendy's T&M 2026" />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="c-client">Client (blank = every client)</label>
              <input id="c-client" className="fld" value={client} onChange={(e) => setClient(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="c-entity">Billing entity (blank = every entity)</label>
              <input id="c-entity" className="fld" value={entity} onChange={(e) => setEntity(e.target.value)} placeholder="SFM" />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="c-kind">Kind</label>
              <select id="c-kind" className="fld" value={kind} onChange={(e) => setKind(e.target.value as ContractKind)}>
                {CONTRACT_KINDS.map((k) => (
                  <option key={k} value={k}>{CONTRACT_KIND_LABELS[k]}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="lbl" htmlFor="c-account">Account code</label>
              <input id="c-account" className="fld" value={account} onChange={(e) => setAccount(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="c-start">Starts</label>
              <input id="c-start" className="fld" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="c-end">Ends (blank = open)</label>
              <input id="c-end" className="fld" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="c-trades">Trades covered (comma-separated, blank = all)</label>
              <input id="c-trades" className="fld" value={trades} onChange={(e) => setTrades(e.target.value)} placeholder="HVAC, Plumbing" />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="c-sites">Sites covered (store numbers or names, blank = all)</label>
              <input id="c-sites" className="fld" value={sites} onChange={(e) => setSites(e.target.value)} placeholder="1234, 1240" />
            </div>
            <div className="field intake-wide">
              <label className="lbl" htmlFor="c-notes">Notes</label>
              <textarea id="c-notes" className="fld" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <div className="field">
              <label className="ck">
                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                <span>Active</span>
              </label>
            </div>
          </div>

          <h3 className="card-title" style={{ marginTop: 14 }}>Rates</h3>
          <p className="hint">
            A row with a trade applies to that trade only; a row without applies to every trade the
            contract covers. Overtime ÷ standard becomes the quote's OT multiplier.
          </p>
          <table className="ct">
            <thead>
              <tr>
                <th>Rate</th>
                <th>Trade (blank = any)</th>
                <th className="num">Amount</th>
                <th style={{ width: 34 }} />
              </tr>
            </thead>
            <tbody>
              {rates.map((r, i) => (
                <tr key={r.key}>
                  <td>
                    <select className="fld" value={r.rate_type} onChange={(e) => setRate(i, { rate_type: e.target.value as RateType })} aria-label={`Rate ${i + 1} type`}>
                      {RATE_TYPES.map((t) => (
                        <option key={t} value={t}>{RATE_TYPE_LABELS[t]}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input className="fld" value={r.trade} onChange={(e) => setRate(i, { trade: e.target.value })} aria-label={`Rate ${i + 1} trade`} />
                  </td>
                  <td>
                    <span className="money-in">
                      <span className="cur" aria-hidden="true">{RATE_TYPE_UNITS[r.rate_type] === 'pct' ? '%' : '$'}</span>
                      <input
                        className="fld"
                        inputMode="decimal"
                        value={r.amount}
                        onChange={(e) => setRate(i, { amount: e.target.value })}
                        aria-label={`Rate ${i + 1} amount`}
                        placeholder={RATE_TYPE_UNITS[r.rate_type] === 'hour' ? 'per hour' : RATE_TYPE_UNITS[r.rate_type] === 'trip' ? 'per visit' : 'percent'}
                      />
                    </span>
                  </td>
                  <td>
                    <button type="button" className="rowdel" aria-label={`Remove rate ${i + 1}`} onClick={() => setRates(rates.filter((_, j) => j !== i))}>
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRates([...rates, { key: ++seq, rate_type: 'standard', trade: '', amount: '' }])}>
            <Icon name="plus" size={12} /> Add rate
          </button>

          {error && <p className="modal-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <span className="card-meta">{missing ? `Still needs ${missing}` : 'Ready'}</span>
          <button type="button" className="btn-sm is-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-sm is-primary" disabled={Boolean(missing) || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : contract ? 'Save contract' : 'Create contract'}
          </button>
        </div>
      </div>
    </div>
  );
}
