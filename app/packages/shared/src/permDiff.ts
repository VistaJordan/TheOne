// What a role edit or a per-person "Adjust" actually changed, path by path.
// The audit row keeps the whole permission map before and after (roles.ts
// `role_updated`, users.ts `user_permissions_set`); read as a whole it says
// "84 entries → 84 entries". This lists every action whose stored grant moved,
// named the way the Roles screen names it, so Admin › Audit and its CSV say
// what was ticked or unticked — and what to set back to undo it. Pure.

import {
  buildPermissionTree,
  PERM_ACTIONS,
  PERM_ACTION_LABELS,
  type PermAction,
  type PermNode,
} from './permissions';

export interface PermChange {
  /** The stored path, e.g. `work_orders/status`. */
  path: string;
  /** The path as the Roles screen names it, e.g. "Work orders › Status". */
  label: string;
  action: PermAction;
  /** `null` = no entry: the action inherits from the path above. */
  from: boolean | null;
  to: boolean | null;
}

let labelCache: Map<string, string> | null = null;

/** path → "Parent › Child" from the static tree (fields and dashboard
    records are not in it; `permPathLabel` names those by their last part). */
function treeLabels(): Map<string, string> {
  if (labelCache) return labelCache;
  const out = new Map<string, string>();
  const walk = (nodes: PermNode[], prefix: string) => {
    for (const n of nodes) {
      const label = prefix ? `${prefix} › ${n.label}` : n.label;
      out.set(n.key, label);
      if (n.children) walk(n.children, label);
    }
  };
  walk(buildPermissionTree([]), '');
  labelCache = out;
  return out;
}

/** "Work orders › Fields › Finances › 34. Cost" for any stored path: the
    nearest ancestor the tree knows, then the remaining parts as written. */
export function permPathLabel(path: string): string {
  const labels = treeLabels();
  const known = labels.get(path);
  if (known) return known;
  const parts = path.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const head = labels.get(parts.slice(0, i).join('/'));
    if (head) return [head, ...parts.slice(i).map(tidyPart)].join(' › ');
  }
  return parts.map(tidyPart).join(' › ');
}

function tidyPart(p: string): string {
  // Field paths are `fields.<json key>`; the key is the field's own name.
  const s = p.startsWith('fields.') ? p.slice('fields.'.length) : p.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function grantOf(map: unknown, path: string, action: PermAction): boolean | null {
  if (!map || typeof map !== 'object') return null;
  const g = (map as Record<string, unknown>)[path];
  if (!g || typeof g !== 'object') return null;
  const v = (g as Record<string, unknown>)[action];
  return typeof v === 'boolean' ? v : null;
}

/** Every (path, action) whose stored grant differs between two maps, in path
    order. A map that is not an object counts as empty. */
export function permMapChanges(before: unknown, after: unknown): PermChange[] {
  const keys = (m: unknown) => (m && typeof m === 'object' ? Object.keys(m as object) : []);
  const paths = [...new Set([...keys(before), ...keys(after)])].sort();
  const out: PermChange[] = [];
  for (const path of paths) {
    for (const action of PERM_ACTIONS) {
      const from = grantOf(before, path, action);
      const to = grantOf(after, path, action);
      if (from !== to) out.push({ path, label: permPathLabel(path), action, from, to });
    }
  }
  return out;
}

/** "yes" / "no" / "inherits" — the three states a grant can be stored in. */
export function permGrantWord(v: boolean | null): string {
  return v === null ? 'inherits' : v ? 'yes' : 'no';
}

/** One line per change: "Work orders › Status · Edit: yes → no". */
export function permChangeLine(c: PermChange): string {
  return `${c.label} · ${PERM_ACTION_LABELS[c.action]}: ${permGrantWord(c.from)} → ${permGrantWord(c.to)}`;
}

/** The snapshot keys that hold a permission map (role, per-person overrides). */
export const PERM_SNAPSHOT_KEYS: readonly string[] = ['permissions', 'overrides'];
