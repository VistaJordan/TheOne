import type { WorkOrderDetailV2 } from '../../api/client';
import { initials } from '../../lib/fields';
import { derivePeople } from '../../lib/woDerive';

interface PeopleCardProps {
  wo: WorkOrderDetailV2;
}

/** AM + assignees + routed lists. The comp's dashed external-vendor block is
    omitted deliberately: the detail payload carries no vendor link yet, and a
    dashed placeholder would read as "we have a vendor" when we do not. */
export function PeopleCard({ wo }: PeopleCardProps) {
  const people = derivePeople(wo);

  return (
    <section className="card">
      <div className="card-head"><h2 className="card-title">People</h2></div>
      {people.length === 0 ? (
        <div className="empty-flat">Nobody is attached to this work order.</div>
      ) : (
        <div className="people">
          {people.map((p) => (
            <div className="person" key={`${p.name}-${p.role}`}>
              <span className={`avatar${p.accent ? ' av-accent' : ''}`} aria-hidden="true">
                {initials(p.name)}
              </span>
              <span>
                <span className="p-name">{p.name}</span>
                <span className="p-role">{p.role}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
