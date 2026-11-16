import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ApprovalTask, WorkOrderDetailV2 } from '../../api/client';
import { listWorkOrderApprovals } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DASH, FIELD, field, isCostOverNte, money, num, numericDate, str } from '../../lib/fields';
import { resolveMoney } from '../../lib/woDerive';
import { Icon } from '../Icon';
import { InlineField } from './fieldEdit';
import { NoteField } from './ManagerFlags';
import { PROFITABILITY_EXCEPTION_KEY, PROFITABILITY_NOTES_KEY, PROJECTED_COST_FIELD_KEY, markupPct } from '@theone/shared';

interface MoneyCardProps {
  wo: WorkOrderDetailV2;
}

/** The Finances tab card. Mirrors the All-fields FINANCES section (Not Fully
    Paid, Client NTE, Cost, Total Invoiced, Discount, Profit) in the section's
    own clean labels — no ClickUp key prefixes. The NTE meter (quote or
    invoiced against the NTE) was removed on 2026-11-16 (Elise); the Markup
    ((Total Invoiced − Cost) ÷ Cost) and the Margin (percentages only) close
    the list. Every
    stored value edits in place (InlineField); the margin stays derived. The
    Client Quote moved to its own card beside this one (ClientQuoteCard). */
export function MoneyCard({ wo }: MoneyCardProps) {
  const m = resolveMoney(wo);
  const f = wo.fields ?? {};
  const comp = wo.billing_entity ?? str(field(f, FIELD.comp));
  const discount = num(field(f, 'Discount'));
  // 2026-11-16 (Elise): Markup = (Total Invoiced − Cost) ÷ Cost.
  const markup = markupPct(m.invoiced, m.cost);

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

      <NteOverrideLine wo={wo} />

      <dl className="kvlist">
        <div className="kvrow">
          <dt>Not fully paid</dt>
          <dd>
            <InlineField wo={wo} fieldKey="fields.1. Not Fully Paid" label="Not fully paid" />
          </dd>
        </div>
        {/* 2026-11-16 (0152): the expected cost is typed here; Cost below
            is written by the payments only — it moves when AP pays one. */}
        <MoneyRow
          wo={wo}
          label="Projected cost"
          fieldKey={`fields.${PROJECTED_COST_FIELD_KEY}`}
          value={num(field(f, PROJECTED_COST_FIELD_KEY))}
        />
        <MoneyRow
          wo={wo}
          label="Cost"
          fieldKey={`fields.${FIELD.cost}`}
          value={m.cost}
          overNte={isCostOverNte(m.cost, m.nte)}
          title="Written by the payments — it moves when AP pays a payment request"
        />
        <MoneyRow wo={wo} label="Total invoiced" fieldKey={`fields.${FIELD.invoiced}`} value={m.invoiced} />
        <MoneyRow wo={wo} label="Discount" fieldKey="fields.Discount" value={discount} />
        {/* 2026-10-22 (0094): a manager accepts this job's margin as it is and
            says why. Two ordinary fields of the Finances section; the
            dispatcher tiers are view-only on them. */}
        <div className="kvrow">
          <dt>Profitability exception</dt>
          <dd>
            <InlineField wo={wo} fieldKey={`fields.${PROFITABILITY_EXCEPTION_KEY}`} label="Profitability exception" />
          </dd>
        </div>
        <div className="kvrow is-note">
          <dt>Manager notes</dt>
          <dd>
            <NoteField
              wo={wo}
              fieldKey={`fields.${PROFITABILITY_NOTES_KEY}`}
              label="Manager notes"
              placeholder="Why this margin is accepted"
            />
          </dd>
        </div>
        {/* 2026-11-16 (Elise) · how much we marked the job up: (Total
            Invoiced − Cost) ÷ Cost. A percentage only, like the margin. */}
        <div className="kvrow" title="(Total invoiced − Cost) ÷ Cost">
          <dt>Markup</dt>
          <dd className={[
            markup == null ? 'is-none' : '',
            markup != null && markup < 0 ? 'is-neg' : '',
          ].filter(Boolean).join(' ')}
          >
            {markup == null ? DASH : `${Math.round(markup)}%`}
          </dd>
        </div>
        {/* 2026-11-03 (Elise) · the margin shows as a percentage only, never
            as a dollar figure. */}
        <div className="kvrow is-total">
          <dt>Margin</dt>
          <dd className={[
            m.marginPct == null ? 'is-none' : '',
            m.marginPct != null && m.marginPct < 0 ? 'is-neg' : '',
          ].filter(Boolean).join(' ')}
          >
            {m.marginPct == null ? DASH : `${Math.round(m.marginPct)}%`}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** Where the NTE override stands (rule 1.5.2, 0026): the latest override task
    on this work order — waiting on a manager, approved, rejected — or nothing
    when the cost never went over. Reads the inbox's own rows, so the card and
    the Approvals page can never disagree. */
function NteOverrideLine({ wo }: { wo: WorkOrderDetailV2 }) {
  const { can } = useAuth();
  const allowed = can('approvals', 'view');
  const q = useQuery({
    queryKey: ['wo-approvals', wo.wo_number],
    queryFn: () => listWorkOrderApprovals(wo.wo_number),
    enabled: allowed,
    retry: 0,
  });
  const latest: ApprovalTask | undefined = q.data?.items.find((t) => t.type === 'nte_override');
  if (!allowed || !latest || latest.status === 'cancelled') return null;

  const by = latest.decided_by?.display_name;
  const when = numericDate(latest.decided_at);
  const text =
    latest.status === 'open'
      ? 'NTE override awaiting a manager'
      : latest.status === 'approved'
        ? 'NTE override approved'
        : 'NTE override rejected';
  const trail =
    latest.status === 'open'
      ? (latest.source?.name ?? null)
      : [by ? `by ${by}` : null, when].filter(Boolean).join(' · ') || null;

  return (
    <div className={`nte-override is-${latest.status}`} title={latest.decision_note ?? latest.title}>
      <Icon name={latest.status === 'approved' ? 'check-circle' : latest.status === 'rejected' ? 'x' : 'inbox'} size={12} />
      <Link to="/approvals">{text}</Link>
      {trail && <small>{trail}</small>}
    </div>
  );
}

function MoneyRow({
  wo,
  label,
  fieldKey,
  value,
  overNte,
  title,
}: {
  wo: WorkOrderDetailV2;
  label: string;
  fieldKey: string;
  value: number | null;
  /** Cost above the client NTE — the row reads in red everywhere it appears. */
  overNte?: boolean;
  title?: string;
}) {
  return (
    <div className={`kvrow${overNte ? ' is-over-nte' : ''}`}>
      <dt>{label}</dt>
      <dd
        className={[value == null ? 'is-none' : '', overNte ? 'is-over-nte' : '']
          .filter(Boolean)
          .join(' ') || undefined}
        title={overNte ? 'Cost is above the client NTE' : title}
      >
        <InlineField wo={wo} fieldKey={fieldKey} label={label}>
          {value == null ? DASH : money(value)}
        </InlineField>
      </dd>
    </div>
  );
}
