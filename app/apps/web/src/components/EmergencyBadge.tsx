import { Icon } from './Icon';

/** Rule 2.5.1 — the red "Emergency" mark a flagged work order carries in every
    view (list rows, the header, the inbox and the queues, search hits). The
    row itself also takes an `is-emergency` class for the red rail; this is the
    label that says why. */
export function EmergencyBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={`emg${compact ? ' emg-compact' : ''}`}
      role="img"
      aria-label="Emergency"
      title="Emergency work order"
    >
      <Icon name="alert" size={12} />
      {!compact && <span className="emg-text">Emergency</span>}
    </span>
  );
}
