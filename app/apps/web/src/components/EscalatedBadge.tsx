import { Icon } from './Icon';

/** Rules 7.3.1–7.3.3 — the amber "Escalated" mark a flagged work order carries
    in every view (list rows, the header, the inbox and the queues, search
    hits), the sibling of EmergencyBadge. The row also takes an `is-escalated`
    class for the rail; when a row is both, the Emergency red rail wins and
    both labels show. */
export function EscalatedBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={`esc${compact ? ' esc-compact' : ''}`}
      role="img"
      aria-label="Escalated"
      title="Escalated work order — on the Escalation Tracker and pinned to the top of the inbox"
    >
      <Icon name="alert-circle" size={12} />
      {!compact && <span className="esc-text">Escalated</span>}
    </span>
  );
}
