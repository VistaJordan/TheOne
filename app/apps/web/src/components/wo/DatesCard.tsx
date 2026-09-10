import type { WorkOrderDetailV2 } from '../../api/client';
import { DASH, str } from '../../lib/fields';
import { QUOTE_DUE_FIELD_KEY, QUOTE_DUE_HINT, quoteOwedIn } from '../../lib/quoteDue';
import { FIELD_SECTIONS } from '../../lib/woFieldSections';
import { Icon } from '../Icon';
import { InlineField, useWoCatalogue } from './fieldEdit';

interface DatesCardProps {
  wo: WorkOrderDetailV2;
}

/** 'Aug 31, 2026, 2:30 PM' — always the full year; the time only when the
    value carries one (a bare or midnight-normalized date shows just the day). */
function fullDateTime(raw: unknown): string | null {
  const s = str(raw);
  if (!s) return null;
  const iso = s.replace(' ', 'T');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hasTime = /T\d{2}:\d{2}/.test(iso) && !/T00:00(:00)?$/.test(iso);
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (!hasTime) return day;
  return `${day}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

/** The Dates tab: exactly the All-fields DATES section (Today, SLA Requested,
    SLA Updated, Date-Time Received, Date Created, Due Date, Scheduled Date,
    Parts Arrival Date, Quote Due Date), driven by the same section config so
    the two views cannot drift. Every row edits in place except Quote Due
    Date, which the API computes (0024); an SLA/due date in the past wears the
    warn ramp — Quote Due Date only while the quote is still owed. */
export function DatesCard({ wo }: DatesCardProps) {
  const byKey = useWoCatalogue();
  const keys = FIELD_SECTIONS.find((s) => s.title === 'Dates')?.keys ?? [];
  const fields = keys
    .map((k) => byKey.get(k))
    .filter((f): f is NonNullable<typeof f> => Boolean(f));
  const bag = wo.fields ?? {};

  return (
    <section className="card dates-card">
      <div className="card-head"><h2 className="card-title">Dates</h2></div>
      {fields.length === 0 ? (
        <div className="empty-flat">Loading the date fields…</div>
      ) : (
        <div className="dates">
          {fields.map((f) => {
            const raw = bag[f.key.slice('fields.'.length)];
            // A value the Date parser rejects (e.g. a formula's output) still
            // shows as its raw text rather than vanishing.
            const text = fullDateTime(raw) ?? str(raw);
            const isQuoteDue = f.key === QUOTE_DUE_FIELD_KEY;
            const deadline = /SLA|Due/i.test(f.label);
            const past =
              text != null && !Number.isNaN(Date.parse(String(str(raw)).replace(' ', 'T')))
                ? Date.parse(String(str(raw)).replace(' ', 'T')) < Date.now()
                : false;
            // A quote that went out on time is not late just because its
            // clock has run out (rule 2.3.3: status before Quote Ready).
            const overdue = isQuoteDue ? past && quoteOwedIn(wo.status?.name) : deadline && past;
            return (
              <div className="date-row" key={f.key} title={isQuoteDue ? QUOTE_DUE_HINT : undefined}>
                <span className="date-k">{f.label}</span>
                <span className={`date-v${text == null ? ' is-none' : overdue ? ' is-warn' : ''}`}>
                  <InlineField wo={wo} fieldKey={f.key} label={f.label}>
                    {overdue && <Icon name="alert" size={12} />}
                    {text ?? DASH}
                    {overdue ? (isQuoteDue ? ' · quote overdue' : ' · overdue') : ''}
                  </InlineField>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
