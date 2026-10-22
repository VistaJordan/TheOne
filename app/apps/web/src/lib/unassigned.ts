// The Incoming › Unassigned list query (2026-10-22), shared by the page and
// the tab strip's count so the tab never costs a second call.
import { UNASSIGNED_LIST_CAP, unassignedWorkFilter } from '@theone/shared';
import { listWorkOrders } from '../api/client';
import { FIELD } from './fields';

export const UNASSIGNED_STORE_KEY = `fields.${FIELD.store}`;

export const UNASSIGNED_QUERY_KEY = ['work-orders', 'unassigned'] as const;

export function fetchUnassigned() {
  return listWorkOrders({
    filters: unassignedWorkFilter(),
    columns: [UNASSIGNED_STORE_KEY],
    sort: { field: 'date_received', dir: 'asc' },
    limit: UNASSIGNED_LIST_CAP,
  });
}
