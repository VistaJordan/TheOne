/* The "awaiting acceptance" chip on a new work order's header (0036, rules
   7.1.1 – 7.1.4).

   Sits beside the status pill while the acceptance task is open: the work
   order has no assignee yet and a manager has to accept (and assign) or
   reject it under Approvals › Pending acceptance. The decision itself lives
   in the inbox — this only says so, and points a manager there. Anyone may
   see the chip. */

import { Link } from 'react-router-dom';
import {
  ACCEPTANCE_SOURCE_LABEL,
  APPROVALS_PERM_KEY,
  approvalSectionPermKey,
  type AcceptanceState,
} from '@theone/shared';
import { useAuth } from '../../auth/AuthProvider';
import { numericDate } from '../../lib/fields';
import { Icon } from '../Icon';

export function AcceptanceChip({ state }: { state: AcceptanceState }) {
  const { can } = useAuth();
  const mayDecide = can(APPROVALS_PERM_KEY, 'view') && can(approvalSectionPermKey('intake'), 'approve');
  const since = numericDate(state.raised_at);

  return (
    <span className="scr scr-open scr-intake" role="status">
      <Icon name="inbox" size={12} />
      <span className="scr-text">
        <b>Awaiting acceptance</b> · from {ACCEPTANCE_SOURCE_LABEL[state.source]}
        {since && <small> · since {since}</small>}
      </span>
      {mayDecide && (
        <Link className="scr-act" to="/approvals">Accept or reject</Link>
      )}
    </span>
  );
}
