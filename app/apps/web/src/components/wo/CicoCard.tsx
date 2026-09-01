import type { WorkOrderDetailV2 } from '../../api/client';
import { str } from '../../lib/fields';
import { FIELD_SECTIONS } from '../../lib/woFieldSections';
import { InlineField, useWoCatalogue } from './fieldEdit';

const CICO_SECTION_TITLE = 'CICO';

/** The key whose value leads the card — check-in/out is the state the rest of
    the section (how they checked in, the pin they used, what they signed)
    explains. */
const STATUS_KEY = 'fields.18. Check-in/out Status';

interface CicoCardProps {
  wo: WorkOrderDetailV2;
}

/** The CICO tab: the All-fields "CICO" section — check-in/out status, method,
    IVR link and pin, sign-off link — driven by FIELD_SECTIONS so the tab and
    the All-fields page cannot drift apart, exactly as the Dates and Payables
    tabs are. Every row edits in place through the shared PATCH path, so a
    change here is the same change made there. */
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
            </div>
          )}

          <dl className="fieldlist">
            {rest.map((f) => (
              <div className="fieldrow" key={f.key}>
                <dt>{f.label}</dt>
                <dd>
                  <InlineField wo={wo} fieldKey={f.key} label={f.label} />
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}
