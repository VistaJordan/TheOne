/* /prices — the price list (0101): what the team charges, per entity, per
   client and per trade, as the old "Prices & quotes library" sheet kept it.

   One tab per entity (Comp). Under it the Standard card first, then a card
   per client: trip charge, materials markup, labor rates by trade and the
   special fees. A client card states only what differs — a trade it does not
   list is priced from the Standard card, which the card says.

   Everyone with `prices` view reads it; only `prices` create / edit / delete
   (the admin role, 0101) see New price card, Edit and Remove, and the API
   refuses the rest. */

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatMarkup,
  formatPriceFee,
  priceCardProblems,
  priceCardTitle,
  priceKey,
  type PriceCard,
  type PriceCardInput,
  type PricesResponse,
} from '@theone/shared';
import { deletePriceCard, getPrices, savePriceCard } from '../api/client';
import { AppShell } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { F, PageTabs, Sheet, errText, numOrNull, usd } from '../components/ui/Sheet';

const PRICES_KEY = ['prices'] as const;

export function PricesPage() {
  const q = useQuery({ queryKey: PRICES_KEY, queryFn: getPrices, retry: 0 });
  const [sp, setSp] = useSearchParams();
  const [search, setSearch] = useState('');
  const [trade, setTrade] = useState('');
  const [editing, setEditing] = useState<PriceCard | 'new' | null>(null);
  const d = q.data;

  // Entities with a card, in the Comp field's order; an admin also sees the
  // empty ones so a first card can be started there.
  const entities = useMemo(() => {
    if (!d) return [];
    const used = d.entities.filter((e) => d.cards.some((c) => priceKey(c.billing_entity) === priceKey(e)));
    return d.can.create ? d.entities : used;
  }, [d]);
  const entity = entities.find((e) => e === sp.get('entity')) ?? entities[0] ?? '';
  const cards = (d?.cards ?? []).filter((c) => priceKey(c.billing_entity) === priceKey(entity));
  const needle = priceKey(search);
  const shown = cards.filter((c) => !needle || priceKey(priceCardTitle(c)).includes(needle));

  return (
    <AppShell active="Prices">
      <div className="canvas-inner">
        <div className="vend-head">
          <div className="page-head" style={{ margin: 0 }}><h1 className="page-title">Prices</h1></div>
          {d?.can.create && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
              <Icon name="plus" size={12} /> New price card
            </button>
          )}
        </div>
        {q.isError ? (
          <section className="card"><div className="empty-flat">{errText(q.error, 'Could not load the price list.')}</div></section>
        ) : !d ? (
          <section className="card"><div className="empty-flat">Loading…</div></section>
        ) : entities.length === 0 ? (
          <section className="card"><div className="empty-flat">The price list is empty.</div></section>
        ) : (
          <>
            <PageTabs
              tabs={entities.map((e) => ({ id: e, label: e, count: d.cards.filter((c) => priceKey(c.billing_entity) === priceKey(e)).length }))}
              value={entity}
              onChange={(id) => setSp({ entity: id }, { replace: true })}
            />
            <div className="vend-filters">
              <input className="fld vend-search" type="search" placeholder="Search client" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search client" />
              <select className="fld" value={trade} onChange={(e) => setTrade(e.target.value)} aria-label="Trade">
                <option value="">Every trade</option>
                {d.trades.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {shown.length === 0 && (
              <section className="card"><div className="empty-flat">{needle ? 'No card matches.' : `${entity} has no price card yet.`}</div></section>
            )}
            <div className="price-grid">
              {shown.map((c) => (
                <PriceCardView key={c.id} card={c} standard={cards.find((x) => x.client === null) ?? null} trade={trade} meta={d} onEdit={() => setEditing(c)} />
              ))}
            </div>
          </>
        )}
      </div>
      {editing && d && (
        <PriceCardDialog
          card={editing === 'new' ? null : editing}
          entity={entity}
          meta={d}
          onClose={() => setEditing(null)}
          onSaved={(saved) => { setEditing(null); setSp({ entity: saved.billing_entity }, { replace: true }); }}
        />
      )}
    </AppShell>
  );
}

function PriceCardView({ card, standard, trade, meta, onEdit }: {
  card: PriceCard;
  standard: PriceCard | null;
  trade: string;
  meta: PricesResponse;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => deletePriceCard(card.id),
    onSuccess: () => { setRemoving(false); void qc.invalidateQueries({ queryKey: PRICES_KEY }); },
    onError: (e) => { setRemoving(false); setError(errText(e, 'Could not remove the card.')); },
  });
  const t = priceKey(trade);
  const rates = t ? card.rates.filter((r) => r.trades.some((x) => priceKey(x) === t)) : card.rates;
  const fromStandard = t && rates.length === 0 && card.client !== null
    ? standard?.rates.filter((r) => r.trades.some((x) => priceKey(x) === t)) ?? []
    : [];
  const hasRowTrip = card.rates.some((r) => r.trip_rate !== null);
  const trip = card.trip_rate ?? (card.client !== null ? standard?.trip_rate ?? null : null);
  const tripInherited = card.trip_rate === null && card.client !== null && trip !== null;

  return (
    <section className="card price-card">
      <div className="card-head">
        <h2 className="card-title grow">
          {priceCardTitle(card)}
          {card.client === null && <span className="price-std-hint">Every client of {card.billing_entity} without a card of its own</span>}
          {!card.client_on_file && <span className="chip chip-sm chip-warn" title="No client record of this name — add it under Clients so work orders can match it">No client record</span>}
        </h2>
        {meta.can.edit && <button type="button" className="btn btn-sm" onClick={onEdit}><Icon name="pencil" size={12} /> Edit</button>}
        {meta.can.delete && (
          <button type="button" className="icon-btn" aria-label={`Remove ${priceCardTitle(card)}`} onClick={() => setRemoving(true)}><Icon name="trash" size={12} /></button>
        )}
      </div>
      <div className="card-pad">
      <dl className="price-terms">
        <div><dt>Trip</dt><dd>{trip === null ? (hasRowTrip ? 'Per trade' : '—') : trip === 0 ? 'No trip' : usd(trip)}{tripInherited && <span className="price-from"> (Standard)</span>}</dd></div>
        <div><dt>Materials markup</dt><dd>{formatMarkup(card.materials_markup ?? (card.client !== null ? standard?.materials_markup ?? null : null))}</dd></div>
      </dl>
      {card.note && <p className="price-note">{card.note}</p>}
      {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}

      {(rates.length > 0 || fromStandard.length > 0) && (
        <div className="vend-wrap">
          <table className="vend-table mt-table price-table">
            <thead>
              <tr>
                <th>Trade</th>
                <th className="num">Tech / hr</th>
                <th className="num">Helper / hr</th>
                <th className="num">After-hours / hr</th>
                <th className="num">Holiday / hr</th>
                {hasRowTrip && <th className="num">Trip</th>}
              </tr>
            </thead>
            <tbody>
              {(rates.length > 0 ? rates : fromStandard).map((r) => (
                <tr key={r.id} className={rates.length === 0 ? 'is-inherited' : undefined}>
                  <td>
                    <div className="price-label">{r.label}</div>
                    {r.trades.join(', ') !== r.label && <div className="price-trades">{r.trades.join(' · ')}</div>}
                  </td>
                  <td className="num">{usd(r.tech_rate)}</td>
                  <td className="num">{r.helper_rate === null ? 'NA' : usd(r.helper_rate)}</td>
                  <td className="num">{usd(r.afterhours_rate)}</td>
                  <td className="num">{usd(r.holiday_rate)}</td>
                  {hasRowTrip && <td className="num">{usd(r.trip_rate)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {fromStandard.length > 0 && <p className="price-from-line">Not on this card — the Standard rate applies.</p>}
      {t && rates.length === 0 && fromStandard.length === 0 && <p className="price-from-line">No rate for {trade} on this card.</p>}
      {!t && card.rates.length === 0 && card.client !== null && <p className="price-from-line">No labor rates of its own — the Standard card's apply.</p>}
      {!t && card.rates.length > 0 && card.client !== null && <p className="price-from-line">A trade not listed here is priced from the Standard card.</p>}

      {card.fees.length > 0 && (
        <>
          <h3 className="price-sub">Special fees</h3>
          <dl className="price-fees">
            {card.fees.map((f) => (
              <div key={f.id}><dt>{f.name}</dt><dd>{formatPriceFee(f)}</dd></div>
            ))}
          </dl>
        </>
      )}
      </div>
      {removing && (
        <ConfirmDialog
          title={`Remove ${card.billing_entity} · ${priceCardTitle(card)}?`}
          message="Its trip, markup, rates and fees go with it. Quotes already priced keep their lines."
          confirmLabel="Remove"
          danger
          busy={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setRemoving(false)}
        />
      )}
    </section>
  );
}

// ── The editor ───────────────────────────────────────────────────────────────

interface RateDraft { key: number; label: string; trades: string[]; tech: string; helper: string; after: string; holiday: string; trip: string }
interface FeeDraft { key: number; name: string; amount: string; note: string }

const RATE_FIELDS = [
  ['tech', 'Tech / hr'],
  ['helper', 'Helper / hr'],
  ['after', 'After-hours / hr'],
  ['holiday', 'Holiday / hr'],
  ['trip', 'Own trip'],
] as const;

const s = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
let nextKey = 1;

function PriceCardDialog({ card, entity, meta, onClose, onSaved }: {
  card: PriceCard | null;
  entity: string;
  meta: PricesResponse;
  onClose: () => void;
  onSaved: (card: PriceCard) => void;
}) {
  const qc = useQueryClient();
  const [ent, setEnt] = useState(card?.billing_entity ?? entity);
  const [client, setClient] = useState(card?.client ?? '');
  const [trip, setTrip] = useState(s(card?.trip_rate));
  const [markup, setMarkup] = useState(s(card?.materials_markup ?? (card ? null : 1.3)));
  const [note, setNote] = useState(card?.note ?? '');
  const [rates, setRates] = useState<RateDraft[]>(() => (card?.rates ?? []).map((r) => ({
    key: nextKey++, label: r.label, trades: r.trades, tech: s(r.tech_rate), helper: s(r.helper_rate), after: s(r.afterhours_rate), holiday: s(r.holiday_rate), trip: s(r.trip_rate),
  })));
  const [fees, setFees] = useState<FeeDraft[]>(() => (card?.fees ?? []).map((f) => ({ key: nextKey++, name: f.name, amount: s(f.amount), note: f.note ?? '' })));
  const [problem, setProblem] = useState<string | null>(null);

  const setRate = (key: number, patch: Partial<RateDraft>) => setRates((cur) => cur.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const setFee = (key: number, patch: Partial<FeeDraft>) => setFees((cur) => cur.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const save = useMutation({
    mutationFn: () => {
      const input: PriceCardInput = {
        billing_entity: ent,
        client: client.trim() || null,
        trip_rate: numOrNull(trip),
        materials_markup: numOrNull(markup),
        note: note.trim() || null,
        rates: rates.map((r) => ({
          label: r.label.trim() || r.trades.join(' - '),
          trades: r.trades,
          tech_rate: numOrNull(r.tech),
          helper_rate: numOrNull(r.helper),
          afterhours_rate: numOrNull(r.after),
          holiday_rate: numOrNull(r.holiday),
          trip_rate: numOrNull(r.trip),
        })),
        fees: fees.map((f) => ({ name: f.name.trim(), amount: numOrNull(f.amount), note: f.note.trim() || null })),
      };
      const problems = priceCardProblems(input);
      if (problems.length > 0) throw new Error(problems[0]);
      return savePriceCard(card?.id ?? null, input);
    },
    onSuccess: (res) => { void qc.invalidateQueries({ queryKey: PRICES_KEY }); onSaved(res.card); },
    onError: (e) => setProblem(errText(e, 'Could not save the card.')),
  });

  const clientKnown = !client.trim() || meta.clients.some((c) => priceKey(c) === priceKey(client));

  return (
    <Sheet
      title={card ? `${card.billing_entity} · ${priceCardTitle(card)}` : 'New price card'}
      icon="list"
      onClose={onClose}
      problem={problem}
      footer={
        <>
          <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={save.isPending} onClick={() => { setProblem(null); save.mutate(); }}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="pf-form">
        <F label="Entity">
          <select className="fld" value={ent} onChange={(e) => setEnt(e.target.value)}>
            {meta.entities.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </F>
        <F label="Client" hint={!clientKnown ? 'No client record of this name — it will be kept, and flagged.' : 'Leave blank for the Standard card.'}>
          <input className="fld" list="price-clients" value={client} onChange={(e) => setClient(e.target.value)} placeholder="Standard" />
          <datalist id="price-clients">{meta.clients.map((c) => <option key={c} value={c} />)}</datalist>
        </F>
        <F label="Trip" hint={client.trim() ? 'Blank = the Standard card’s trip. 0 = no trip.' : '0 = no trip.'}>
          <input className="fld" inputMode="decimal" value={trip} onChange={(e) => setTrip(e.target.value)} />
        </F>
        <F label="Materials markup (×)" hint="Up to — 1.3 means up to ×1.3.">
          <input className="fld" inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value)} />
        </F>
        <F label="Note" wide>
          <input className="fld" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. After-hours rates start at 5pm." />
        </F>
      </div>

      <h3 className="price-sub">Labor rates</h3>
      <div className="price-rate-list">
        {rates.map((r) => (
          <div key={r.key} className="price-rate-edit">
            <div className="price-rate-top">
              <input className="fld" value={r.label} onChange={(e) => setRate(r.key, { label: e.target.value })} placeholder="Name, e.g. Plumber - Electrician" aria-label="Rate name" />
              <button type="button" className="icon-btn" aria-label="Remove rate" onClick={() => setRates((cur) => cur.filter((x) => x.key !== r.key))}><Icon name="trash" size={12} /></button>
            </div>
            <div className="price-trade-pick">
              <span className="price-pick-lbl">Prices</span>
              {r.trades.map((t) => (
                <button key={t} type="button" className="chip chip-sm" onClick={() => setRate(r.key, { trades: r.trades.filter((x) => x !== t) })} aria-label={`Remove ${t}`}>
                  {t} <Icon name="x" size={12} />
                </button>
              ))}
              <select className="fld" value="" onChange={(e) => e.target.value && setRate(r.key, { trades: [...r.trades, e.target.value] })} aria-label="Add a trade">
                <option value="">+ Trade</option>
                {meta.trades.filter((t) => !r.trades.includes(t)).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="price-rate-nums">
              {RATE_FIELDS.map(([k, label]) => (
                <label key={k} className="pf-field">
                  <span className="lbl">{label}</span>
                  <input className="fld price-num" inputMode="decimal" value={r[k]} onChange={(e) => setRate(r.key, { [k]: e.target.value })} />
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-sm price-add" onClick={() => setRates((cur) => [...cur, { key: nextKey++, label: '', trades: [], tech: '', helper: '', after: '', holiday: '', trip: '' }])}>
        <Icon name="plus" size={12} /> Add rate
      </button>

      <h3 className="price-sub">Special fees</h3>
      <div className="vend-wrap">
        <table className="vend-table mt-table price-edit">
          <thead><tr><th>Fee</th><th className="num">Amount</th><th>Or as written</th><th /></tr></thead>
          <tbody>
            {fees.map((f) => (
              <tr key={f.key}>
                <td><input className="fld" value={f.name} onChange={(e) => setFee(f.key, { name: e.target.value })} placeholder="Snake" aria-label="Fee name" /></td>
                <td className="num"><input className="fld price-num" inputMode="decimal" value={f.amount} onChange={(e) => setFee(f.key, { amount: e.target.value })} aria-label="Amount" /></td>
                <td><input className="fld" value={f.note} onChange={(e) => setFee(f.key, { note: e.target.value })} placeholder="e.g. $350-550" aria-label="Note" /></td>
                <td><button type="button" className="icon-btn" aria-label="Remove fee" onClick={() => setFees((cur) => cur.filter((x) => x.key !== f.key))}><Icon name="trash" size={12} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="btn btn-sm price-add" onClick={() => setFees((cur) => [...cur, { key: nextKey++, name: '', amount: '', note: '' }])}>
        <Icon name="plus" size={12} /> Add fee
      </button>
    </Sheet>
  );
}
