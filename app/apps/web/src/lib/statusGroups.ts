// The phase groups (Open / Active / Done / Closed + admin-added ones) as the
// web consumes them: a query with a hardcoded fallback for the first paint,
// and the bucketing every status menu shares.

import { useQuery } from '@tanstack/react-query';
import { getStatusGroups, type StatusGroupItem } from '../api/client';

/** The four built-ins — used until /status-groups answers (or if it cannot). */
export const FALLBACK_GROUPS: StatusGroupItem[] = [
  { code: 'open', label: 'Open', position: 0, is_builtin: true },
  { code: 'active', label: 'Active', position: 1, is_builtin: true },
  { code: 'done', label: 'Done', position: 2, is_builtin: true },
  { code: 'closed', label: 'Closed', position: 3, is_builtin: true },
];

export function useStatusGroups(enabled = true) {
  const q = useQuery({
    queryKey: ['status-groups'],
    queryFn: getStatusGroups,
    staleTime: 5 * 60 * 1000,
    enabled,
  });
  return { ...q, groups: q.data?.items?.length ? q.data.items : FALLBACK_GROUPS };
}

export interface StatusBucket<T> {
  code: string;
  label: string;
  statuses: (T & { fraction: number })[];
}

/**
 * Bucket statuses by group in group order, position-sorted inside each bucket,
 * stamping each status with its pie fraction ((i+1)/(n+1) within the bucket) —
 * the number the StatusCircle wedge renders. A status whose group the defs
 * don't list (stale cache mid-edit) still shows, labelled by its raw code.
 */
export function bucketStatuses<T extends { group: string; position: number }>(
  statuses: readonly T[],
  groups: readonly Pick<StatusGroupItem, 'code' | 'label'>[],
): StatusBucket<T>[] {
  const byGroup = new Map<string, T[]>();
  for (const s of [...statuses].sort((a, b) => a.position - b.position)) {
    const list = byGroup.get(s.group);
    if (list) list.push(s);
    else byGroup.set(s.group, [s]);
  }

  const withFractions = (list: T[]) =>
    list.map((s, i) => ({ ...s, fraction: (i + 1) / (list.length + 1) }));

  const out: StatusBucket<T>[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    seen.add(g.code);
    const list = byGroup.get(g.code);
    if (list?.length) out.push({ code: g.code, label: g.label, statuses: withFractions(list) });
  }
  for (const [code, list] of byGroup) {
    if (!seen.has(code)) out.push({ code, label: code, statuses: withFractions(list) });
  }
  return out;
}
