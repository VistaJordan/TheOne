/* The two pieces both Receivables subtabs draw with.
 *
 * Lifted out of ReceivablesPage when the Invoicing tab moved into its own file
 * (0045): the audit and the invoicing queue must read as one page, which they
 * only do if the stat cards and the money formatting are literally the same
 * code rather than two copies that drift.
 */

export const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

export type StatTone = 'neutral' | 'major' | 'minor' | 'clean';

export function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: StatTone;
}) {
  return (
    <div className={`rcv-stat is-${tone}`}>
      <span className="rcv-stat-label">
        <span className="rcv-stat-dot" aria-hidden="true" />
        {label}
      </span>
      <span className="rcv-stat-value">{value}</span>
    </div>
  );
}
