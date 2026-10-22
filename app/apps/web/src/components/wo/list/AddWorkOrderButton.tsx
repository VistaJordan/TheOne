/* "Add work order" — the manual create form (0041), opened from Incoming Work
   Orders since 2026-10-22 (Elise: a work order typed in by hand is incoming
   work, so the button lives beside the acceptance queue and the drafts, not
   on the list). One component so both tabs draw the same button and the same
   dialog; gated on `work_orders` create like the form's own routes. */

import { useState } from 'react';
import { useAuth } from '../../../auth/AuthProvider';
import { Icon } from '../../Icon';
import { CreateWorkOrderDialog } from './CreateWorkOrderDialog';

export function AddWorkOrderButton() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  if (!can('work_orders', 'create')) return null;
  return (
    <>
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)} title="Raise a work order by hand">
        <Icon name="plus" size={14} />
        Add work order
      </button>
      {open && <CreateWorkOrderDialog onClose={() => setOpen(false)} />}
    </>
  );
}
