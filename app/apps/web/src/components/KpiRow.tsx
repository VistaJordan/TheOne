import type { Kpis } from '@theone/shared';

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

interface KpiRowProps {
  kpis?: Kpis;
  loading?: boolean;
}

/** Four KPI cards from GET /api/kpis (SPRINT1-SPEC §6). */
export function KpiRow({ kpis, loading }: KpiRowProps) {
  return (
    <div className="kpi-row">
      <KpiCard
        label="Active WOs"
        value={loading ? '—' : String(kpis?.active.count ?? 0)}
        meta="Open + active pipeline"
      />
      <KpiCard
        hot
        label="Waiting approval"
        value={loading ? '—' : String(kpis?.waitingApproval.count ?? 0)}
        meta={
          loading
            ? ' '
            : kpis?.waitingApproval.oldestAgeDays != null
              ? `Oldest ${kpis.waitingApproval.oldestAgeDays}d`
              : 'None waiting'
        }
      />
      <KpiCard
        label="Ready to invoice"
        value={loading ? '—' : String(kpis?.readyToInvoice.count ?? 0)}
        meta={loading ? ' ' : `${money(kpis?.readyToInvoice.queuedAmount ?? 0)} queued`}
      />
      <KpiCard
        label="Margin (30d)"
        value={loading ? '—' : `${(kpis?.margin.pct ?? 0).toFixed(1)}%`}
        meta={
          loading
            ? ' '
            : `${money(kpis?.margin.avgProfit ?? 0)} avg${kpis?.margin.placeholder ? ' · est.' : ''}`
        }
      />
    </div>
  );
}

interface KpiCardProps {
  label: string;
  value: string;
  meta: string;
  hot?: boolean;
}

function KpiCard({ label, value, meta, hot }: KpiCardProps) {
  return (
    <div className={`kpi${hot ? ' hot' : ''}`}>
      <div className="kl">{label}</div>
      <div className="kv">{value}</div>
      <div className="km">{meta}</div>
    </div>
  );
}
