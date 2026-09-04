/* The permission editor (0015) — one tree, every permission in the product.

   Rows are the tree from @theone/shared buildPermissionTree: sections at the
   top (Dashboard, Work orders, Quotes, …), then tabs, field sections and
   fields under Work orders, and the console sections under Admin. Columns are
   the actions. A cell shows the EFFECTIVE answer — what the server will say —
   and where that answer comes from:

     solid            set right here
     faded            inherited from a row above (or, for a person, from their role)
     red ring         set to "no" right here, overriding something above

   Click a cell to set it explicitly; the × beside it puts it back to inherited.
   Switching a whole section on is one click on the section row; every field
   underneath follows until one of them is set on its own. */

import { useMemo, useState } from 'react';
import {
  PERM_ACTIONS,
  PERM_ACTION_LABELS,
  resolvePerm,
  type PermAction,
  type PermMap,
  type PermNode,
} from '@theone/shared';
import { Icon } from '../Icon';

export interface PermissionMatrixProps {
  tree: PermNode[];
  /** The explicit entries being edited. */
  value: PermMap;
  onChange: (next: PermMap) => void;
  /** What an unset cell falls back to after the value's own chain — a
      person's role, when editing overrides. Absent = nothing (no). */
  base?: PermMap;
  /** Names the fallback in the legend ("from the OM role"). */
  baseLabel?: string;
  disabled?: boolean;
}

type Source = 'self' | 'inherited' | 'base' | 'default';

function effective(
  value: PermMap,
  base: PermMap | undefined,
  key: string,
  action: PermAction,
): { on: boolean; source: Source } {
  const own = value[key]?.[action];
  if (typeof own === 'boolean') return { on: own, source: 'self' };
  const inherited = resolvePerm(value, key, action);
  if (typeof inherited === 'boolean') return { on: inherited, source: 'inherited' };
  const fromBase = resolvePerm(base, key, action);
  if (typeof fromBase === 'boolean') return { on: fromBase, source: 'base' };
  return { on: false, source: 'default' };
}

/** How many explicit entries sit on this node or anywhere beneath it. */
function explicitUnder(value: PermMap, key: string): number {
  let n = 0;
  for (const [k, g] of Object.entries(value)) {
    if (k === key || k.startsWith(`${key}/`)) n += Object.keys(g).length;
  }
  return n;
}

function matches(node: PermNode, q: string): boolean {
  if (node.label.toLowerCase().includes(q)) return true;
  return (node.children ?? []).some((c) => matches(c, q));
}

interface Row {
  node: PermNode;
  depth: number;
  open: boolean;
  hasChildren: boolean;
}

export function PermissionMatrix({
  tree,
  value,
  onChange,
  base,
  baseLabel,
  disabled,
}: PermissionMatrixProps) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const query = q.trim().toLowerCase();

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (nodes: PermNode[], depth: number) => {
      for (const node of nodes) {
        if (query && !matches(node, query)) continue;
        const hasChildren = Boolean(node.children && node.children.length > 0);
        // A search opens every matching branch so the hit is visible.
        const isOpen = hasChildren && (query ? true : open.has(node.key));
        out.push({ node, depth, open: isOpen, hasChildren });
        if (isOpen) walk(node.children ?? [], depth + 1);
      }
    };
    walk(tree, 0);
    return out;
  }, [tree, query, open]);

  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const set = (key: string, action: PermAction, v: boolean | undefined) => {
    const next: PermMap = { ...value };
    const grant = { ...(next[key] ?? {}) };
    if (v === undefined) delete grant[action];
    else grant[action] = v;
    // Granting a write implies being able to see the thing being written; a
    // row that could edit but not view is a state nobody means.
    if (v === true && action !== 'view' && !effective(next, base, key, 'view').on) {
      grant.view = true;
    }
    if (Object.keys(grant).length > 0) next[key] = grant;
    else delete next[key];
    onChange(next);
  };

  const clearUnder = (key: string) => {
    const next: PermMap = {};
    for (const [k, g] of Object.entries(value)) {
      if (k === key || k.startsWith(`${key}/`)) continue;
      next[k] = g;
    }
    onChange(next);
  };

  const totalExplicit = Object.values(value).reduce((n, g) => n + Object.keys(g).length, 0);

  return (
    <div className="pm">
      <div className="pm-tools">
        <input
          className="fld sm"
          type="search"
          placeholder="Find a section or field…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Find a permission"
        />
        <button
          type="button"
          className="linkbtn"
          onClick={() => setOpen(new Set(allKeys(tree)))}
        >
          Expand all
        </button>
        <button type="button" className="linkbtn" onClick={() => setOpen(new Set())}>
          Collapse all
        </button>
        <div className="pm-legend" aria-hidden="true">
          <span><i className="pm-swatch is-on" /> Allowed</span>
          <span><i className="pm-swatch" /> Not allowed</span>
          <span><i className="pm-swatch is-on is-inherited" /> Inherited{baseLabel ? ` · ${baseLabel}` : ''}</span>
          <span><i className="pm-swatch is-explicit is-off" /> Denied here</span>
        </div>
      </div>

      <div className="pm-head" role="row">
        <span className="pm-name-h">Section · field</span>
        {PERM_ACTIONS.map((a) => (
          <span key={a}>{PERM_ACTION_LABELS[a]}</span>
        ))}
        <span />
      </div>

      {rows.length === 0 && <div className="pm-empty">Nothing matches “{q}”.</div>}

      {rows.map(({ node, depth, open: isOpen, hasChildren }) => {
        const under = explicitUnder(value, node.key);
        return (
          <div
            key={node.key}
            className={`pm-row depth-${Math.min(depth, 3)}`}
            role="row"
            style={{ paddingLeft: 12 + depth * 18 }}
          >
            <div className="pm-name">
              <button
                type="button"
                className={`pm-tog${hasChildren ? '' : ' is-leaf'}`}
                aria-label={isOpen ? `Collapse ${node.label}` : `Expand ${node.label}`}
                aria-expanded={hasChildren ? isOpen : undefined}
                onClick={() => hasChildren && toggle(node.key)}
                tabIndex={hasChildren ? 0 : -1}
              >
                <Icon name={isOpen ? 'chev-d' : 'chev-r'} size={12} />
              </button>
              <span className="pm-label" title={node.note ?? node.key}>
                {node.label}
              </span>
              {node.note && <small>{node.note}</small>}
            </div>

            {PERM_ACTIONS.map((action) => {
              if (!node.actions.includes(action)) return <span key={action} className="pm-cellwrap" />;
              const { on, source } = effective(value, base, node.key, action);
              const explicit = source === 'self';
              return (
                <span key={action} className="pm-cellwrap">
                  <button
                    type="button"
                    className={`pm-cell${on ? ' is-on' : ' is-off'}${explicit ? ' is-explicit' : ' is-inherited'}`}
                    disabled={disabled}
                    aria-pressed={on}
                    aria-label={`${node.label}: ${PERM_ACTION_LABELS[action]} ${on ? 'allowed' : 'not allowed'}${
                      explicit ? '' : source === 'base' ? ' (from role)' : source === 'inherited' ? ' (inherited)' : ''
                    }`}
                    title={
                      explicit
                        ? 'Set here — click to flip'
                        : source === 'base'
                          ? `From ${baseLabel ?? 'the role'} — click to override`
                          : source === 'inherited'
                            ? 'Inherited from the row above — click to set here'
                            : 'Not set anywhere (no) — click to allow'
                    }
                    onClick={() => set(node.key, action, !on)}
                  >
                    <Icon name={on ? 'check' : 'x'} size={12} />
                  </button>
                  {explicit && !disabled && (
                    <button
                      type="button"
                      className="pm-reset"
                      aria-label={`Reset ${node.label} ${PERM_ACTION_LABELS[action]} to inherited`}
                      title="Back to inherited"
                      onClick={() => set(node.key, action, undefined)}
                    >
                      <Icon name="refresh" size={12} />
                    </button>
                  )}
                </span>
              );
            })}

            <span className="pm-count">
              {hasChildren && under > 0 && !disabled ? (
                <button
                  type="button"
                  className="linkbtn pm-clear"
                  title="Remove every setting in this section so it inherits again"
                  onClick={() => clearUnder(node.key)}
                >
                  clear {under}
                </button>
              ) : hasChildren && under > 0 ? (
                `${under} set`
              ) : null}
            </span>
          </div>
        );
      })}

      <div className="pm-foot">
        <span className="pm-dirty">
          {totalExplicit === 0
            ? base
              ? 'No adjustments — everything comes from the role.'
              : 'Nothing granted yet — this role can do nothing.'
            : `${totalExplicit} setting${totalExplicit === 1 ? '' : 's'}`}
        </span>
        {totalExplicit > 0 && !disabled && (
          <button type="button" className="linkbtn is-danger" onClick={() => onChange({})}>
            {base ? 'Remove all adjustments' : 'Clear everything'}
          </button>
        )}
      </div>
    </div>
  );
}

function allKeys(nodes: PermNode[]): string[] {
  const out: string[] = [];
  const walk = (n: PermNode[]) => {
    for (const node of n) {
      if (node.children?.length) {
        out.push(node.key);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}
