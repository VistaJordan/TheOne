/* The "awaiting acceptance" chip on a new work order's header (0036, rules
   7.1.1 – 7.1.4).

   Sits beside the status pill while the acceptance task is open: the work
   order has no assignee yet and a manager has to accept (and assign) or
   reject it under Incoming Work Orders. The decision itself lives there —
   this only says so, and points a manager there. Rule 11.1.1: while intake
   fields are still empty the chip counts them, since accepting is refused
   until they are filled and this page is where they get typed. Anyone may
   see the chip. */

import { Link } from 'react-router-dom';
import {
  ACCEPTANCE_SOURCE_LABEL,
  APPROVALS_PERM_KEY,
  approvalSectionPermKey,
  describeIntakeGate,
  type AcceptanceState,
} from '@theone/shared';
import { useAuth } from '../../auth/AuthProvider';
import { numericDate } from '../../lib/fields';
import { Icon } from '../Icon';

export function AcceptanceChip({ state }: { state: AcceptanceState }) {
  const { can } = useAuth();
  const mayDecide = can(APPROVALS_PERM_KEY, 'view') && can(approvalSectionPermKey('intake'), 'approve');
  const since = numericDate(state.raised_at);
  const missing = state.missing ?? [];
  const gate = missing.length > 0 ? describeIntakeGate(missing.map((label) => ({ label }))) : null;

  return (
    <span className="scr scr-open scr-intake" role="status" title={gate ?? undefined}>
      <Icon name="download" size={12} />
      <span className="scr-text">
        <b>Awaiting acceptance</b> · from {ACCEPTANCE_SOURCE_LABEL[state.source]}
        {since && <small> · since {since}</small>}
        {gate && (
          <small className="scr-gate">
            {' '}· {missing.length} intake field{missing.length === 1 ? '' : 's'} to fill: {missing.join(', ')}
          </small>
        )}
      </span>
      {mayDecide && (
        <Link className="scr-act" to="/incoming">Accept or reject</Link>
      )}
    </span>
  );
}
