import type { WorkOrderDetailV2 } from '../../api/client';
import { DASH, FIELD, field, money, num, str } from '../../lib/fields';
import { NTE_WARN_PCT, nteBasis, resolveMoney } from '../../lib/woDerive';
import { Icon } from '../Icon';
import { InlineField } from './fieldEdit';

interface MoneyCardProps {
  wo: WorkOrderDetailV2;
}

/** The Finances tab card. Mirrors the All-fields FINANCES section (Not Fully
    Paid, Client NTE, Cost, Total Invoiced, Discount, Profit) in the section's
    own clean labels — no ClickUp key prefixes — plus the one thing this tab
    alone has: the NTE meter (how much of the NTE the invoiced amount has
    eaten). Profit closes the list with its margin %, as a total row. Every
    stored value edits in place (InlineField); Profit stays derived. The
    Client Quote moved to its own card beside this one (ClientQuoteCard). */
export function MoneyCard({ wo }: MoneyCardProps) {
  const m = resolveMoney(wo);
  const f = wo.fields ?? {};
  const comp = wo.billing_entity ?? str(field(f, FIELD.comp));
  const basis = nteBasis(m);
  const discount = num(field(f, 'Discount'));

  // The meter only means something when there is an NTE to press against.
  const pct = basis && m.nte != null && m.nte > 0 ? (basis.value / m.nte) * 100 : null;
  const warn = pct != null && pct >= NTE_WARN_PCT;
  const over = pct != null && pct > 100;

  return (
    <section className="card card-fin">
      <div className="card-head">
        <h2 className="card-title">Finances</h2>
        {comp && <span className="card-meta">{comp}</span>}
      </div>

      <div className="nte-row">
        <span className="nte-k">Client NTE</span>
        <InlineField wo={wo} fieldKey={`fields.${FIELD.nte}`} label="Client NTE" className="nte-v">
          {money(m.nte)}
        </InlineField>
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
            <span>
              {basis.label} {money(basis.value)}
              <span className={`ntemeter-pct${over ? ' is-over' : warn ? ' is-warn' : ''}`}>
                {Math.round(pct)}%
              </span>
            </span>
            <span>NTE {money(m.nte)}</span>
          </div>
          {warn && (
            <div className={`ntemeter-cap${over ? ' is-over' : ''}`}>
              <Icon name="alert" size={12} />
              {over
                ? `Over NTE by ${money(basis.value - (m.nte ?? 0))}`
                : `Past the ${NTE_WARN_PCT}% mark — ${money((m.nte ?? 0) - basis.value)} left`}
            </div>
          )}
        </div>
      )}

      <dl className="kvlist">
        <div className="kvrow">
          <dt>Not fully paid</dt>
          <dd>
            <InlineField wo={wo} fieldKey="fields.1. Not Fully Paid" label="Not fully paid" />
          </dd>
        </div>
        <MoneyRow wo={wo} label="Cost" fieldKey={`fields.${FIELD.cost}`} value={m.cost} />
        <MoneyRow wo={wo} label="Total invoiced" fieldKey={`fields.${FIELD.invoiced}`} value={m.invoiced} />
        <MoneyRow wo={wo} label="Discount" fieldKey="fields.Discount" value={discount} />
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
    </section>
  );
}

function MoneyRow({
  wo,
  label,
  fieldKey,
  value,
}: {
  wo: WorkOrderDetailV2;
  label: string;
  fieldKey: string;
  value: number | null;
}) {
  return (
    <div className="kvrow">
      <dt>{label}</dt>
      <dd className={value == null ? 'is-none' : undefined}>
        <InlineField wo={wo} fieldKey={fieldKey} label={label}>
          {value == null ? DASH : money(value)}
        </InlineField>
      </dd>
    </div>
  );
}
