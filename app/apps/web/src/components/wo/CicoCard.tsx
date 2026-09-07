import { useState } from 'react';
import type { WorkOrderDetailV2 } from '../../api/client';
import { str } from '../../lib/fields';
import { FIELD_SECTIONS } from '../../lib/woFieldSections';
import { InlineField, useWoCatalogue } from './fieldEdit';
import { FieldHistory, HistoryToggle } from './FieldHistory';

const CICO_SECTION_TITLE = 'CICO';

/** The key whose value leads the card — check-in/out is the state the rest of
    the section (when they checked in and out, how, the pin they used, what
    they signed) explains. */
const STATUS_KEY = 'fields.18. Check-in/out Status';

interface CicoCardProps {
  wo: WorkOrderDetailV2;
}

/** The CICO tab: the All-fields "CICO" section — check-in/out status, the two
    stamps the API writes when it moves, method, IVR link and pin, sign-off
    link — driven by FIELD_SECTIONS so the tab and the All-fields page cannot
    drift apart, exactly as the Dates and Payables tabs are. Every row edits
    in place through the shared PATCH path, and every row opens the same
    per-field history the All-fields page has: a check-in time is exactly the
    kind of value somebody later asks "who set that, and when?" about. */
export function CicoCard({ wo }: CicoCardProps) {
  const byKey = useWoCatalogue();
  const keys = FIELD_SECTIONS.find((s) => s.title === CICO_SECTION_TITLE)?.keys ?? [];
  const fields = keys
    .map((k) => byKey.get(k))
    .filter((f): f is NonNullable<typeof f> => Boolean(f));
  const bag = wo.fields ?? {};
  const status = fields.find((f) => f.key === STATUS_KEY);
  const statusValue = status ? str(bag[STATUS_KEY.slice('fields.'.length)]) : null;
  const rest = fields.filter((f) => f.key !== STATUS_KEY);
  // One drawer open at a time, as on the All-fields page.
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const toggle = (key: string) => setHistoryFor((cur) => (cur === key ? null : key));

  return (
    <section className="card card-cico">
      <div className="card-head"><h2 className="card-title">Check-in / check-out</h2></div>

      {fields.length === 0 ? (
        <div className="empty-flat">
          No CICO fields are defined in Admin › Custom fields.
        </div>
      ) : (
        <>
          {status && (
            <>
              <div className="cico-state">
                <span className="cico-state-k">{status.label}</span>
                <InlineField
                  wo={wo}
                  fieldKey={status.key}
                  label={status.label}
                  className="cico-state-v"
                >
                  <span className={`chip${statusValue ? ' chip-accent' : ''}`}>
                    {statusValue ?? 'Not checked in'}
                  </span>
                </InlineField>
                <HistoryToggle
                  field={status}
                  open={historyFor === status.key}
                  onToggle={() => toggle(status.key)}
                />
              </div>
              {historyFor === status.key && (
                <div className="cico-history"><FieldHistory woId={wo.id} field={status} /></div>
              )}
            </>
          )}

          <dl className="fieldlist">
            {rest.map((f) => (
              <div key={f.key}>
                <div className="fieldrow has-hist">
                  <dt>{f.label}</dt>
                  <dd>
                    <InlineField wo={wo} fieldKey={f.key} label={f.label} />
                    <HistoryToggle
                      field={f}
                      open={historyFor === f.key}
                      onToggle={() => toggle(f.key)}
                    />
                  </dd>
                </div>
                {historyFor === f.key && <FieldHistory woId={wo.id} field={f} />}
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}
