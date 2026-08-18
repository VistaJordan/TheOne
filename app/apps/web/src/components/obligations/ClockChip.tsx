import type { ObligationSummary } from '../../api/client';
import { useNow } from '../../hooks/useNow';
import {
  TIER_LABEL,
  dueTitle,
  formatClock,
  ruleChipLabel,
  sortByBreach,
  tierClass,
  tierOf,
} from '../../lib/obligations';
import { Icon } from '../Icon';

interface ClockChipProps {
  ob: ObligationSummary;
  /** Interactive chips (header cluster) scroll to the rail card. */
  onClick?: () => void;
  /** Table cells drop the icon to keep the column narrow. */
  compact?: boolean;
}

/**
 * The clock chip — one obligation, one deadline, one colour.
 *
 * Colour is the TIER, never the rule: an operator learns one ramp (muted →
 * warn → danger → pulsing danger) and reads urgency without reading words.
 * A snoozed obligation keeps its tier colour but says so, because a snooze is a
 * promise to come back, not a resolution.
 */
export function ClockChip({ ob, onClick, compact }: ClockChipProps) {
  const now = useNow();
  const tier = tierOf(ob);
  const clock = formatClock(ob.due_at, now);
  const snoozed = ob.state === 'snoozed';

  const body = (
    <>
      {!compact && <Icon name={tier >= 2 ? 'alert' : 'clock'} size={12} />}
      <span className="clock-chip-label">{ruleChipLabel(ob)}</span>
      {!clock.unknown && (
        <span className="clock-chip-time">{snoozed ? `snoozed · ${clock.text}` : clock.text}</span>
      )}
    </>
  );

  const className = [
    'clock-chip',
    tierClass(tier),
    snoozed ? 'is-snoozed' : '',
    compact ? 'is-compact' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const title = `${dueTitle(ob)} · ${TIER_LABEL[tier]}`;

  if (!onClick) {
    return (
      <span className={className} title={title}>
        {body}
      </span>
    );
  }
  return (
    <button type="button" className={`${className} is-button`} title={title} onClick={onClick}>
      {body}
    </button>
  );
}

/** The header's chip cluster — worst first, capped so a bad day still lays out. */
export function ClockChipCluster({
  items,
  onSelect,
  max = 3,
}: {
  items: readonly ObligationSummary[];
  onSelect?: () => void;
  max?: number;
}) {
  const now = useNow();
  if (items.length === 0) return null;
  const ordered = sortByBreach(items, now);
  const shown = ordered.slice(0, max);
  const rest = ordered.length - shown.length;
  return (
    <div className="clock-cluster">
      {shown.map((ob) => (
        <ClockChip key={ob.id} ob={ob} onClick={onSelect} />
      ))}
      {rest > 0 && (
        <button type="button" className="clock-chip tier-0 is-button" onClick={onSelect}>
          <span className="clock-chip-label">+{rest} more</span>
        </button>
      )}
    </div>
  );
}
