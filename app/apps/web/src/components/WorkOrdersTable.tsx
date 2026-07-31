import { Link, useNavigate } from 'react-router-dom';
import type { WorkOrderListItem } from '@theone/shared';
import { StatusChangeMenu } from './StatusChangeMenu';

const money = (n: number | null) =>
  n == null
    ? '—'
    : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

interface WorkOrdersTableProps {
  items: WorkOrderListItem[];
  loading?: boolean;
  error?: string | null;
}

/** The S1 work-orders table (SPRINT1-SPEC §6). S2: rows navigate to the WO
    detail page; the WO # cell is a real link so keyboard + middle-click work. */
export function WorkOrdersTable({ items, loading, error }: WorkOrdersTableProps) {
  const navigate = useNavigate();
  return (
    <div className="table-wrap">
      <table className="ct">
        <thead>
          <tr>
            <th className="col-wo">WO #</th>
            <th className="col-client">Client / Site</th>
            <th className="col-trade">Trade</th>
            <th className="col-status">Status</th>
            <th className="col-nte num">NTE</th>
            <th className="col-list">Home list</th>
            <th className="col-age num">Age</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr className="ct-empty">
              <td colSpan={7}>Loading work orders…</td>
            </tr>
          )}
          {error && !loading && (
            <tr className="ct-empty">
              <td colSpan={7}>{error}</td>
            </tr>
          )}
          {!loading && !error && items.length === 0 && (
            <tr className="ct-empty">
              <td colSpan={7}>No work orders match.</td>
            </tr>
          )}
          {!loading &&
            !error &&
            items.map((wo) => (
              <tr
                key={wo.id}
                className="is-clickable"
                onClick={() => navigate(`/work-orders/${encodeURIComponent(wo.wo_number)}`)}
              >
                <td className="col-wo">
                  <Link
                    className="wo-num wo-num-link"
                    to={`/work-orders/${encodeURIComponent(wo.wo_number)}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {wo.wo_number}
                  </Link>
                </td>
                <td className="col-client">
                  <div className="site">
                    <strong>{wo.client ?? '—'}</strong>
                    <small>{subLine(wo)}</small>
                  </div>
                </td>
                <td className="col-trade">{wo.trade ?? '—'}</td>
                {/* The status menu is interactive — its clicks must not
                    bubble up to the row's navigate handler. */}
                <td className="col-status" onClick={(e) => e.stopPropagation()}>
                  <StatusChangeMenu woId={wo.id} current={wo.status} />
                </td>
                <td className="col-nte num">{money(wo.nte)}</td>
                <td className="col-list">{wo.home_list ?? '—'}</td>
                <td className="col-age num">{wo.age_days == null ? '—' : `${wo.age_days}d`}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function subLine(wo: WorkOrderListItem): string {
  const loc = [wo.city, wo.state].filter(Boolean).join(', ');
  const parts = [loc, wo.ext_name].filter((p) => p && p.length > 0);
  return parts.join(' · ') || '—';
}
