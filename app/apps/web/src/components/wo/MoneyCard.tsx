import { Link } from 'react-router-dom';
import type { WorkOrderDetailV2, QuoteStatus } from '../../api/client';
import { DASH, FIELD, field, money, str } from '../../lib/fields';
import { NTE_WARN_PCT, nteBasis, resolveMoney } from '../../lib/woDerive';
import { QUOTE_STATUS } from '../quote/QuoteStatusPill';
import { Icon } from '../Icon';

interface MoneyCardProps {
  wo: WorkOrderDetailV2;
  /** S4 entry point: the quote's status when one exists, null when none does,
      undefined while the lookup is still in flight (the button waits rather
      than flickering "Create quote" at a WO that already has one). */
  quoteStatus?: QuoteStatus | null;
}

export function MoneyCard({ wo, quoteStatus }: MoneyCardProps) {
  const m = resolveMoney(wo);
  const comp = wo.billing_entity ?? str(field(wo.fields ?? {}, FIELD.comp));
  const basis = nteBasis(m);

  // The meter only means something when there is an NTE to press against.
  const pct = basis && m.nte != null && m.nte > 0 ? (basis.value / m.nte) * 100 : null;
  const warn = pct != null && pct >= NTE_WARN_PCT;
  const over = pct != null && pct > 100;

  const empty =
    m.nte == null && m.quote == null && m.cost == null && m.invoiced == null && m.profit == null;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Money</h2>
        {comp && <span className="card-meta">21. Comp · {comp}</span>}
      </div>

      {empty ? (
        <div className="empty-flat">No financials recorded on this work order yet.</div>
      ) : (
        <>
          <div className="nte-row">
            <span className="nte-k">
              <span className="reddot" aria-hidden="true" />
              16. Client NTE
            </span>
            <span className="nte-v">{money(m.nte)}</span>
          </div>

          {pct != null && basis && (
            <div className="ntemeter">
              <div
                className="ntemeter-track"
                role="img"
                aria-label={`${basis.label} is ${Math.round(pct)} percent of the client NTE`}
              >
                <div
                  className={`ntemeter-fill${over ? ' is-over' : warn ? ' is-warn' : ''}`}
                  style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }}
                />
                <div className="ntemeter-thresh" title={`${NTE_WARN_PCT}% warning threshold`} />
              </div>
              <div className="ntemeter-scale">
                <span>{basis.label} {money(basis.value)}</span>
                <span>NTE {money(m.nte)}</span>
              </div>
              {warn && (
                <div className="ntemeter-cap">
                  <Icon name="alert" size={12} />
                  {basis.label} is {Math.round(pct)}% of NTE
                </div>
              )}
            </div>
          )}

          <dl className="kvlist">
            <MoneyRow label="Quote" value={m.quote} />
            <MoneyRow label="34. Cost" value={m.cost} />
            <MoneyRow label="Total invoiced" value={m.invoiced} />
            <div className="kvrow is-total">
              <dt>Profit</dt>
              <dd className={[
                m.profit == null ? 'is-none' : '',
                m.profit != null && m.profit < 0 ? 'is-neg' : '',
              ].filter(Boolean).join(' ')}
              >
                {money(m.profit)}
                {m.marginPct != null && (
                  <span className={`margin-chip${m.marginPct < 0 ? ' is-neg' : ''}`}>
                    {Math.round(m.marginPct)}%
                  </span>
                )}
              </dd>
            </div>
          </dl>
        </>
      )}

      {quoteStatus !== undefined && (
        <div className="card-foot">
          <Link
            className="btn btn-sm"
            to={`/work-orders/${encodeURIComponent(wo.wo_number)}/quote`}
          >
            <Icon name="file" size={12} />
            {quoteStatus === null ? 'Create quote' : 'Open quote'}
          </Link>
          {quoteStatus !== null && (
            <span className="chip chip-sm">{QUOTE_STATUS[quoteStatus]?.label ?? quoteStatus}</span>
          )}
        </div>
      )}
    </section>
  );
}

function MoneyRow({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="kvrow">
      <dt>{label}</dt>
      <dd className={value == null ? 'is-none' : undefined}>{value == null ? DASH : money(value)}</dd>
    </div>
  );
}
