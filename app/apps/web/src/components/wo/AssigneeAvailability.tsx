// Who is free to take a work order — the availability view every Assignee
// picker opens beside its search.
//
// Picking a dispatcher used to mean knowing the team: the Add work order
// form, Accept on Incoming, a Draft's Submit & assign and the seat on the work
// order itself all offered one list of names and nothing else. The panel here
// answers the question the manager actually has — "who do we have on this
// client, and how loaded are they?" — from GET /principals/availability:
//
//   For <client>      the people Admin › Users lists on the work order's
//                     client (0072 principal_client)
//   All dispatchers   everyone in a dispatcher tier; "everyone else" folds in
//                     the rest, since a manager may keep a job
//
// Either way the number beside a name is ALL their active work orders, every
// client — being light on this account means nothing if they are drowning on
// another. Fewest first by default (who is free); one click flips it to most
// first (who needs relief). The chevron on a row opens that person's load per
// status. Clicking a name picks them, exactly as the search would have.
//
// Two shells share the panel: `AssigneeSelect` wraps the <select> the dialogs
// already use and drops the panel in beneath it; the inline ComboSelect on
// the work order swaps its option list for the panel (fieldEdit.tsx).

import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  filterAvailability,
  othersCount,
  sortAvailability,
  type AvailabilityOrder,
  type AvailabilityPerson,
  type AvailabilityScope,
} from '@theone/shared';
import { ApiRequestError, getAssigneeAvailability } from '../../api/client';
import { initials } from '../../lib/fields';
import { Icon } from '../Icon';

interface AvailabilityPanelProps {
  /** The work order's client, or null when the form has none yet. */
  client: string | null | undefined;
  /** The name currently in the seat — drawn ticked. */
  current: string;
  onPick: (name: string) => void;
  disabled?: boolean;
  /** Inside the inline combo: tighter rows, no footnote. */
  compact?: boolean;
}

export function AvailabilityPanel({ client, current, onPick, disabled = false, compact = false }: AvailabilityPanelProps) {
  const clientName = (client ?? '').trim() || null;
  const q = useQuery({
    queryKey: ['assignee-availability', clientName ?? ''],
    queryFn: () => getAssigneeAvailability(clientName),
    staleTime: 30 * 1000,
    retry: 0,
  });
  const items = q.data?.items ?? [];
  const forClient = useMemo(() => items.filter((p) => p.for_client).length, [items]);
  const dispatchers = useMemo(() => items.filter((p) => p.dispatcher).length, [items]);
  const others = othersCount(items);

  // The client list opens first when it has anyone on it; a form with no
  // client yet, or a client nobody is assigned to, lands on all dispatchers.
  const [scopeChoice, setScopeChoice] = useState<AvailabilityScope | null>(null);
  const scope: AvailabilityScope = scopeChoice ?? (clientName && forClient > 0 ? 'client' : 'all');
  const [order, setOrder] = useState<AvailabilityOrder>('freest');
  const [includeOthers, setIncludeOthers] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const shown = useMemo(
    () => sortAvailability(filterAvailability(items, scope, includeOthers), order),
    [items, scope, includeOthers, order],
  );
  const max = Math.max(1, ...shown.map((p) => p.active));

  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  let body: ReactNode;
  if (q.isLoading) {
    body = <p className="avl-empty">Loading who is available…</p>;
  } else if (q.isError) {
    body = (
      <p className="avl-empty is-err" role="alert">
        {q.error instanceof ApiRequestError ? q.error.message : 'Could not load the team’s load — try again.'}
      </p>
    );
  } else if (scope === 'client' && shown.length === 0) {
    body = (
      <p className="avl-empty">
        Nobody is assigned to <b>{clientName}</b> in Admin › Users yet.{' '}
        <button type="button" className="avl-link" onClick={() => setScopeChoice('all')}>Show all dispatchers</button>
      </p>
    );
  } else if (shown.length === 0) {
    body = <p className="avl-empty">Nobody is in a dispatcher tier. {others > 0 && <button type="button" className="avl-link" onClick={() => setIncludeOthers(true)}>Show everyone ({others})</button>}</p>;
  } else {
    body = (
      <ul className="avl-list">
        {shown.map((p) => (
          <PersonRow
            key={p.id}
            person={p}
            max={max}
            current={p.name === current}
            expanded={open.has(p.id)}
            disabled={disabled}
            onPick={() => onPick(p.name)}
            onToggle={() => toggleOpen(p.id)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className={`avl${compact ? ' is-compact' : ''}`}>
      <div className="avl-head">
        <div className="seg avl-scope" role="tablist" aria-label="Which people">
          <button
            type="button"
            role="tab"
            className={`seg-btn${scope === 'client' ? ' is-on' : ''}`}
            aria-selected={scope === 'client'}
            disabled={!clientName}
            title={clientName ? `The people assigned to ${clientName} in Admin › Users` : 'Pick a client first'}
            onClick={() => setScopeChoice('client')}
          >
            {clientName ? `For ${clientName}` : 'For this client'}
            {q.data && clientName ? <span className="avl-count">{forClient}</span> : null}
          </button>
          <button
            type="button"
            role="tab"
            className={`seg-btn${scope === 'all' ? ' is-on' : ''}`}
            aria-selected={scope === 'all'}
            title="Every dispatcher, whatever their clients"
            onClick={() => setScopeChoice('all')}
          >
            All dispatchers
            {q.data ? <span className="avl-count">{includeOthers ? items.length : dispatchers}</span> : null}
          </button>
        </div>
        <button
          type="button"
          className="avl-sort"
          title={order === 'freest' ? 'Showing the fewest active work orders first — click for most first' : 'Showing the most active work orders first — click for fewest first'}
          onClick={() => setOrder((o) => (o === 'freest' ? 'busiest' : 'freest'))}
        >
          <Icon name={order === 'freest' ? 'sort' : 'sort-down'} size={12} />
          {order === 'freest' ? 'Fewest first' : 'Most first'}
        </button>
      </div>

      {body}

      {scope === 'all' && others > 0 && shown.length > 0 && (
        <button type="button" className="avl-others" onClick={() => setIncludeOthers((v) => !v)}>
          {includeOthers ? 'Only dispatchers' : `Show everyone else (${others})`}
        </button>
      )}
      {!compact && (
        <p className="avl-note">Active = all of a person’s open work orders, on every client, not just this one.</p>
      )}
    </div>
  );
}

function PersonRow({
  person: p,
  max,
  current,
  expanded,
  disabled,
  onPick,
  onToggle,
}: {
  person: AvailabilityPerson;
  max: number;
  current: boolean;
  expanded: boolean;
  disabled: boolean;
  onPick: () => void;
  onToggle: () => void;
}) {
  const pct = Math.round((p.active / max) * 100);
  return (
    <li className={`avl-row${current ? ' is-current' : ''}${expanded ? ' is-open' : ''}`}>
      <div className="avl-line">
        <button
          type="button"
          className="avl-pick"
          disabled={disabled}
          title={current ? `${p.name} holds this work order` : `Assign to ${p.name}`}
          onClick={onPick}
        >
          <span className="avatar av-sm" aria-hidden="true">{initials(p.name)}</span>
          <span className="avl-who">
            <b>{p.name}</b>
            <small>
              {p.role_label ?? 'No role'}
              {p.for_client && <span className="avl-tag">On this client</span>}
            </small>
          </span>
          <span className="avl-load" title={`${p.active} active work order${p.active === 1 ? '' : 's'}, every client`}>
            <span className="avl-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
            <span className="avl-n">{p.active}</span>
          </span>
          {current && <Icon name="check" size={12} className="avl-check" />}
        </button>
        <button
          type="button"
          className="avl-more"
          aria-expanded={expanded}
          aria-label={expanded ? `Hide ${p.name}’s work orders per status` : `Show ${p.name}’s work orders per status`}
          disabled={p.active === 0}
          title={p.active === 0 ? 'No active work orders' : 'Their active work orders, per status'}
          onClick={onToggle}
        >
          <Icon name={expanded ? 'chev-u' : 'chev-d'} size={12} />
        </button>
      </div>
      {expanded && p.active > 0 && (
        <ul className="avl-status">
          {p.by_status.map((s) => (
            <li key={s.name}>
              <span className="avl-dot" aria-hidden="true" style={s.color ? { background: s.color } : undefined} />
              <span className="avl-sname">{s.name}</span>
              <span className="avl-n">{s.n}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ── The dialogs' shell: the <select> they already draw, plus the panel ───────

interface AssigneeSelectProps {
  id: string;
  value: string;
  onChange: (name: string) => void;
  client: string | null | undefined;
  disabled?: boolean;
  autoFocus?: boolean;
  /** The <option>s — each dialog keeps its own grouping and placeholder. */
  children: ReactNode;
}

/** A name can still be typed into the search the way it always was; the
    "Who's available?" button beside it opens the load view underneath. */
export function AssigneeSelect({ id, value, onChange, client, disabled = false, autoFocus = false, children }: AssigneeSelectProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="avl-select">
      <div className="avl-select-row">
        <select id={id} className="fld" value={value} autoFocus={autoFocus} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {children}
        </select>
        <button
          type="button"
          className={`btn-sm is-ghost avl-toggle${open ? ' is-on' : ''}`}
          aria-expanded={open}
          aria-controls={`${id}-availability`}
          title="Who is free to take this: the people on this client, or every dispatcher, with their active work orders"
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="user" size={12} />
          Who’s available?
        </button>
      </div>
      {open && (
        <div id={`${id}-availability`}>
          <AvailabilityPanel
            client={client}
            current={value}
            disabled={disabled}
            onPick={(name) => {
              onChange(name);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
