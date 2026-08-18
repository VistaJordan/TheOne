import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Obligation } from '../api/client';
import { listWorkOrders } from '../api/client';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { SnoozeDialog } from '../components/obligations/SnoozeDialog';
import { useNow } from '../hooks/useNow';
import { usePulse } from '../hooks/useObligations';
import {
  TIER_LABEL,
  formatClock,
  ownerDisplay,
  ruleFullLabel,
  ruleWhy,
  sortByBreach,
  tierClass,
  tierOf,
} from '../lib/obligations';

/**
 * The Pulse — every open obligation, arranged by how much of its clock is gone.
 *
 * Three columns, left to right, in the order a dispatcher triages: what is
 * already breached and mine to fix, what is about to break (the storm front),
 * and what is merely being watched. Nothing here is dismissible: a card leaves
 * this board when the EVIDENCE that silences it exists, or when someone snoozes
 * it with a reason and a new deadline.
 */
export function PulsePage() {
  const now = useNow();
  const [snoozing, setSnoozing] = useState<Obligation | null>(null);
  const pulse = usePulse();

  // Sidebar badge parity with the other pages (same cache key family).
  const totalQuery = useQuery({
    queryKey: ['work-orders', { limit: 1 }],
    queryFn: () => listWorkOrders({ limit: 1 }),
  });

  const board = pulse.data ?? { needs_me_now: [], due_soon: [], watching: [] };
  const needsMe = sortByBreach(board.needs_me_now, now);
  const dueSoon = sortByBreach(board.due_soon, now);
  const watching = sortByBreach(board.watching, now);
  const totalOpen = needsMe.length + dueSoon.length + watching.length;
  // "Nothing is owed" and "nobody is watching" look identical on screen and are
  // opposite facts — the board never conflates them.
  const offline = Boolean(pulse.data?.unavailable) || pulse.isError;
  const allClear = !pulse.isLoading && !offline && totalOpen === 0;

  return (
    <AppShell total={totalQuery.data?.total} active="Pulse">
      <div className="page-head">
        <h1 className="page-title">Pulse</h1>
        <p className="page-sub">
          {pulse.isLoading
            ? 'Reading the clocks…'
            : offline
              ? 'The obligation engine is not answering — the board retries every minute.'
              : `${totalOpen} open obligation${totalOpen === 1 ? '' : 's'} · ${needsMe.length} needs attention now · refreshes every minute`}
        </p>
      </div>

      {offline && totalOpen === 0 ? (
        <div className="pulse-clear">
          <img className="pulse-mascot" src="/brand/mascot.png" alt="" />
          <b>The watchdog is off its leash.</b>
          <span>
            The obligation engine did not answer. This is not an all-clear — nothing is being
            watched until it comes back. The board retries on its own every minute.
          </span>
        </div>
      ) : allClear ? (
        <div className="pulse-clear">
          <img className="pulse-mascot" src="/brand/mascot.png" alt="" />
          <b>All clear — the watchdog is watching.</b>
          <span>
            Nothing is owed past its clock right now. New obligations appear here the moment a
            deadline starts running.
          </span>
        </div>
      ) : (
        <div className="pulse-cols">
          <PulseColumn
            kind="now"
            title="Needs me now"
            hint="Breached and critical — tier 2 and 3"
            items={needsMe}
            now={now}
            loading={pulse.isLoading}
            error={pulse.isError}
            onSnooze={setSnoozing}
          />
          <PulseColumn
            kind="soon"
            title="Due soon"
            hint="80% of the clock gone — the storm front"
            items={dueSoon}
            now={now}
            loading={pulse.isLoading}
            error={pulse.isError}
            onSnooze={setSnoozing}
          />
          <PulseColumn
            kind="watch"
            title="Watching"
            hint="Running clocks with room left"
            items={watching}
            now={now}
            loading={pulse.isLoading}
            error={pulse.isError}
            onSnooze={setSnoozing}
            compact
          />
        </div>
      )}

      {snoozing && <SnoozeDialog ob={snoozing} onClose={() => setSnoozing(null)} />}
    </AppShell>
  );
}

interface PulseColumnProps {
  kind: 'now' | 'soon' | 'watch';
  title: string;
  hint: string;
  items: Obligation[];
  now: number;
  loading?: boolean;
  error?: boolean;
  compact?: boolean;
  onSnooze: (ob: Obligation) => void;
}

function PulseColumn({
  kind,
  title,
  hint,
  items,
  now,
  loading,
  error,
  compact,
  onSnooze,
}: PulseColumnProps) {
  return (
    <section className={`pulse-col is-${kind}`} aria-label={title}>
      <header className="pulse-col-head">
        <h2 className="pulse-col-title">{title}</h2>
        <span className="pulse-col-count">{loading ? '—' : items.length}</span>
      </header>
      <p className="pulse-col-hint">{hint}</p>

      {loading && <div className="pulse-col-note">Loading…</div>}
      {error && !loading && <div className="pulse-col-note">Unavailable.</div>}
      {!loading && !error && items.length === 0 && (
        <div className="pulse-col-note">Nothing here.</div>
      )}

      <div className="pulse-stack">
        {items.map((ob) =>
          compact ? (
            <PulseMiniRow key={ob.id} ob={ob} now={now} onSnooze={onSnooze} />
          ) : (
            <PulseCard key={ob.id} ob={ob} now={now} onSnooze={onSnooze} />
          ),
        )}
      </div>
    </section>
  );
}

interface CardProps {
  ob: Obligation;
  now: number;
  onSnooze: (ob: Obligation) => void;
}

function PulseCard({ ob, now, onSnooze }: CardProps) {
  const tier = tierOf(ob);
  const clock = formatClock(ob.due_at, now);
  const owner = ownerDisplay(ob);
  const why = ruleWhy(ob.rule_key);

  return (
    <article className={`pulse-card ${tierClass(tier)}`}>
      <div className="pulse-card-top">
        <span className={`pulse-card-tier ${tierClass(tier)}`}>{TIER_LABEL[tier]}</span>
        <span className={`pulse-card-clock${clock.overdue ? ' is-over' : ''}`}>
          {clock.unknown ? '—' : clock.text}
        </span>
      </div>

      <h3 className="pulse-card-rule">{ruleFullLabel(ob)}</h3>

      {ob.wo_number ? (
        <Link className="pulse-card-wo" to={`/work-orders/${encodeURIComponent(ob.wo_number)}`}>
          {ob.wo_number}
          {ob.client ? <span className="pulse-card-client">{ob.client}</span> : null}
        </Link>
      ) : (
        <span className="pulse-card-wo is-none">No work order linked</span>
      )}

      {ob.state === 'snoozed' && ob.snooze_reason ? (
        <p className="pulse-card-why">Snoozed — {ob.snooze_reason}</p>
      ) : (
        why && <p className="pulse-card-why">{why}</p>
      )}

      <div className="pulse-card-foot">
        <span className="pulse-owner" title={owner.name}>
          <span className="pulse-avatar" aria-hidden="true">{owner.initials}</span>
          <span className="pulse-owner-name">{owner.name}</span>
        </span>
        <button type="button" className="obl-snooze" onClick={() => onSnooze(ob)}>
          <Icon name="clock" size={12} />
          Snooze
        </button>
      </div>
    </article>
  );
}

/** The Watching column is a scan, not a read — one line per obligation. */
function PulseMiniRow({ ob, now, onSnooze }: CardProps) {
  const tier = tierOf(ob);
  const clock = formatClock(ob.due_at, now);
  const owner = ownerDisplay(ob);
  return (
    <div className={`pulse-mini ${tierClass(tier)}`}>
      <span className="pulse-mini-dot" aria-hidden="true" />
      <div className="pulse-mini-body">
        <span className="pulse-mini-rule">{ruleFullLabel(ob)}</span>
        <span className="pulse-mini-meta">
          {ob.wo_number ? (
            <Link className="pulse-mini-wo" to={`/work-orders/${encodeURIComponent(ob.wo_number)}`}>
              {ob.wo_number}
            </Link>
          ) : (
            <span className="pulse-mini-wo is-none">—</span>
          )}
          <span className="pulse-mini-owner" title={owner.name}>
            {owner.initials}
          </span>
        </span>
      </div>
      <span className={`pulse-mini-clock${clock.overdue ? ' is-over' : ''}`}>
        {clock.unknown ? '—' : clock.text}
      </span>
      <button
        type="button"
        className="pulse-mini-snooze"
        aria-label="Snooze this obligation"
        title="Snooze"
        onClick={() => onSnooze(ob)}
      >
        <Icon name="clock" size={12} />
      </button>
    </div>
  );
}
