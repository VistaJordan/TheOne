import { useState } from 'react';
import type { Obligation } from '../../api/client';
import { useNow } from '../../hooks/useNow';
import {
  TIER_LABEL,
  formatClock,
  ownerDisplay,
  ruleFullLabel,
  ruleWhy,
  sortByBreach,
  tierClass,
  tierOf,
} from '../../lib/obligations';
import { Icon } from '../Icon';
import { SnoozeDialog } from './SnoozeDialog';

/** The anchor the header's clock chips scroll to. */
export const OBLIGATIONS_CARD_ID = 'obligations';

interface ObligationsCardProps {
  items: Obligation[];
  loading?: boolean;
  error?: boolean;
}

/** The WO rail's "what this job owes" card — every open clock on one work
    order, worst first, each with the one action that is allowed (snooze). */
export function ObligationsCard({ items, loading, error }: ObligationsCardProps) {
  const now = useNow();
  const [snoozing, setSnoozing] = useState<Obligation | null>(null);
  const open = sortByBreach(items.filter((ob) => ob.state !== 'resolved'), now);

  return (
    <section className="card obl-card" id={OBLIGATIONS_CARD_ID}>
      <div className="card-head">
        <h2 className="card-title">Obligations</h2>
        <span className="card-meta">
          {loading ? '—' : `${open.length} open`}
        </span>
      </div>

      {loading && <div className="obl-note">Checking the clocks…</div>}
      {error && !loading && <div className="obl-note">Could not read the obligation engine.</div>}
      {!loading && !error && open.length === 0 && (
        <div className="obl-note obl-clear">
          <Icon name="check-circle" size={14} />
          Nothing owed on this work order.
        </div>
      )}

      {!loading && !error && open.length > 0 && (
        <ul className="obl-list">
          {open.map((ob) => {
            const tier = tierOf(ob);
            const clock = formatClock(ob.due_at, now);
            const owner = ownerDisplay(ob);
            const why = ruleWhy(ob.rule_key);
            return (
              <li key={ob.id} className={`obl-row ${tierClass(tier)}`}>
                <div className="obl-row-top">
                  <span className="obl-dot" aria-hidden="true" />
                  <span className="obl-rule">{ruleFullLabel(ob)}</span>
                  <span className={`obl-clock${clock.overdue ? ' is-over' : ''}`}>
                    {clock.unknown ? '—' : clock.text}
                  </span>
                </div>
                <div className="obl-row-mid">
                  <span className={`obl-tier ${tierClass(tier)}`}>{TIER_LABEL[tier]}</span>
                  <span className="obl-owner" title={owner.name}>
                    <span className="obl-avatar" aria-hidden="true">{owner.initials}</span>
                    {owner.name}
                  </span>
                  <button
                    type="button"
                    className="obl-snooze"
                    onClick={() => setSnoozing(ob)}
                  >
                    <Icon name="clock" size={12} />
                    Snooze
                  </button>
                </div>
                {ob.state === 'snoozed' && ob.snooze_reason && (
                  <p className="obl-why">Snoozed — {ob.snooze_reason}</p>
                )}
                {ob.state !== 'snoozed' && why && <p className="obl-why">{why}</p>}
              </li>
            );
          })}
        </ul>
      )}

      {snoozing && <SnoozeDialog ob={snoozing} onClose={() => setSnoozing(null)} />}
    </section>
  );
}
