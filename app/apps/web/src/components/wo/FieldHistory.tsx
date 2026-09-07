/* Per-field history: the drawer that lists every recorded change of ONE field
   on ONE work order, and the small clock button that opens it. Lifted out of
   AllFieldsPanel so the tab cards (CICO, Payables, …) offer the same history
   on their rows — the All-fields page must not be the only place a value's
   past can be seen. */

import { useQuery } from '@tanstack/react-query';
import type { ActivityEntry, WoFieldDescriptor } from '@theone/shared';
import { ApiRequestError, getFieldHistory } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DASH, feedTime, initials } from '../../lib/fields';
import { formatValue, unwrap } from '../../lib/auditFormat';
import { Icon } from '../Icon';

export function FieldHistory({ woId, field }: { woId: string; field: WoFieldDescriptor }) {
  const historyQuery = useQuery({
    queryKey: ['wo-field-history', woId, field.key],
    queryFn: () => getFieldHistory(woId, field.key),
    retry: 0,
  });

  if (historyQuery.isLoading) {
    return <div className="afp-history"><span className="afp-none">Loading history…</span></div>;
  }
  if (historyQuery.isError) {
    const err = historyQuery.error;
    const forbidden = err instanceof ApiRequestError && err.status === 403;
    return (
      <div className="afp-history">
        <span className="afp-none">
          {forbidden ? 'Your role cannot view field history.' : 'History unavailable.'}
        </span>
      </div>
    );
  }

  const items = historyQuery.data?.items ?? [];
  if (items.length === 0) {
    return (
      <div className="afp-history">
        <span className="afp-none">No recorded changes — this value has held since import.</span>
      </div>
    );
  }

  return (
    <ol className="afp-history">
      {items.map((e: ActivityEntry) => {
        const who = e.actor?.display_name ?? 'System';
        const before = formatValue(unwrap(e.before), field);
        const after = formatValue(unwrap(e.after), field);
        return (
          <li key={e.id} className="afp-hrow">
            <span className={`audit-av${e.actor?.kind === 'service' ? ' is-service' : ''}`} aria-hidden="true">
              {initials(who)}
            </span>
            <p className="afp-htext">
              <b>{who}</b>{' '}
              {before === DASH && after !== DASH ? (
                <>set it to <span className="audit-val">{after}</span></>
              ) : after === DASH && before !== DASH ? (
                <>cleared it (was <span className="audit-val">{before}</span>)</>
              ) : (
                <>changed it from <span className="audit-val">{before}</span> to{' '}
                  <span className="audit-val">{after}</span></>
              )}
            </p>
            <time className="audit-time" dateTime={e.created_at}>{feedTime(e.created_at)}</time>
          </li>
        );
      })}
    </ol>
  );
}

/** May the acting principal open field history at all? (0015) */
export function useCanViewHistory(): boolean {
  return useAuth().can('work_orders/history', 'view');
}

interface HistoryToggleProps {
  field: WoFieldDescriptor;
  open: boolean;
  onToggle: () => void;
}

/** The clock button beside a field's value. Renders nothing for a role
    without the history grant — the drawer would only say no. */
export function HistoryToggle({ field, open, onToggle }: HistoryToggleProps) {
  const canHistory = useCanViewHistory();
  if (!canHistory) return null;
  return (
    <button
      type="button"
      className={`afp-act${open ? ' is-on' : ''}`}
      title={`History of ${field.label}`}
      aria-label={`History of ${field.label}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <Icon name="history" size={12} />
    </button>
  );
}
