import type { WorkOrderDetailV2 } from '../../api/client';
import { FIELD, initials } from '../../lib/fields';
import { derivePeople, type PersonSlot } from '../../lib/woDerive';
import { InlineField, useWoCatalogue } from './fieldEdit';
import { FieldHistory, useCanViewHistory } from './FieldHistory';

interface PeopleCardProps {
  wo: WorkOrderDetailV2;
}

/** The People tab: seven named seats — AM, team lead, associate team lead
    (ATL), assignee, completion
    assignee, previous assignees, sales owner — as a grid of labelled slots,
    then the lists the WO is routed through.

    It used to be one flat column of avatar rows that mixed the seats with the
    routing lists and hid any seat that had nobody in it, so "who is the team
    lead?" and "this WO has no team lead" looked identical. Every seat now
    draws whether or not it is filled; the ones whose field is in the
    catalogue edit in place, the rest fall back to read-only text. */
export function PeopleCard({ wo }: PeopleCardProps) {
  const { slots, attached } = derivePeople(wo);

  return (
    <section className="card card-people">
      <div className="card-head"><h2 className="card-title">People</h2></div>

      <div className="seats">
        {slots.map((s) => <Seat key={s.role} wo={wo} slot={s} />)}
      </div>

      {attached.length > 0 && (
        <>
          <div className="card-head as-sub"><h3 className="card-title">Routing</h3></div>
          <div className="people">
            {attached.map((p) => (
              <div className="person" key={`${p.role}-${p.name}`}>
                <span className="avatar" aria-hidden="true">{initials(p.name)}</span>
                <span>
                  <span className="p-name">{p.name}</span>
                  <span className="p-role">{p.role}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** People › Our team: every recorded change of the Assignee — who made it and
    when — read from the same field history as the clock button in All
    fields. Drawn only for someone with the history grant. */
export function AssignmentHistoryCard({ wo }: PeopleCardProps) {
  const byKey = useWoCatalogue();
  const canHistory = useCanViewHistory();
  const field = byKey.get(`fields.${FIELD.assignee}`);
  if (!canHistory || !field) return null;
  return (
    <section className="card">
      <div className="card-head"><h2 className="card-title">Assignment history</h2></div>
      <FieldHistory woId={wo.id} field={field} />
    </section>
  );
}

function Seat({ wo, slot }: { wo: WorkOrderDetailV2; slot: PersonSlot }) {
  const filled = slot.names.length > 0;

  return (
    <div className={`seat${filled ? '' : ' is-empty'}`}>
      <span className="seat-role">{slot.role}</span>
      {/* An empty seat keeps the pencil: filling it is the whole point of
          showing it. `fieldKey ?? ''` misses the catalogue on purpose for the
          seats it has no definition for — InlineField then renders read-only. */}
      <InlineField wo={wo} fieldKey={slot.fieldKey ?? ''} label={slot.role} className="seat-who">
        {filled ? (
          slot.names.map((n) => (
            <span className="seat-person" key={n}>
              <span className={`avatar av-sm${slot.accent ? ' av-accent' : ''}`} aria-hidden="true">
                {initials(n)}
              </span>
              <span className="p-name">{n}</span>
            </span>
          ))
        ) : (
          <span className="seat-person">
            <span className="avatar av-sm is-blank" aria-hidden="true" />
            <span className="seat-none">Unassigned</span>
          </span>
        )}
      </InlineField>
    </div>
  );
}
