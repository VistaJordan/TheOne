/* 2026-10-27 (Elise) · the account team edited straight from the Clients list:
   Comp, AM, TL, ATL and Sales are click-to-change cells, one line per Comp,
   and "+ Comp" adds a team. Every change is the Account team card's own save
   (POST / PATCH /clients/:id/teams), so it is checked, logged on the client
   and read by Add work order exactly as an edit made on the client's page. */

import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CLIENT_TEAM_HOUSE } from '@theone/shared';
import type { ClientTeamInput, ClientTeamsOverview } from '@theone/shared';
import { saveClientTeam } from '../../api/client';
import { errText } from './PortfolioParts';

type Line = ClientTeamsOverview['teams'][number];
type Seat = 'am' | 'tl' | 'atl' | 'sales';
type Col = 'billing_entity' | Seat;
type Editing = { teamId: string | 'new'; col: Col; old: string };

const COLS: readonly Col[] = ['billing_entity', 'am', 'tl', 'atl', 'sales'];
const LABEL: Record<Col, string> = { billing_entity: 'Comp', am: 'AM', tl: 'TL', atl: 'ATL', sales: 'Sales' };

const ADD = '__add__';

/**
 * 2026-10-28 (Elise) · the Sales seat is a dropdown of the salespeople (the
 * Sales Owner options: Rocio, Teresa, Kevin, House…). **Add someone…** turns
 * it into a box for a new name; saving the team adds that name to the list.
 * `onDone` (the list's cell) is called with a final pick; the forms only need
 * `onChange`.
 */
export function SalesSelect({ value, options, onChange, onDone, onCancel, autoFocus, className = 'fld', disabled }: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  onDone?: (v: string) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  const [typing, setTyping] = useState(false);
  const adding = useRef(false);
  const listed = options.some((o) => o.toLowerCase() === value.trim().toLowerCase());
  const shownValue = listed ? (options.find((o) => o.toLowerCase() === value.trim().toLowerCase()) ?? value) : value;
  if (typing) {
    return (
      <input
        className={className}
        autoFocus
        value={value}
        placeholder="New salesperson"
        aria-label="New salesperson"
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onDone?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onDone?.((e.target as HTMLInputElement).value); }
          if (e.key === 'Escape') { e.stopPropagation(); setTyping(false); onCancel?.(); }
        }}
      />
    );
  }
  return (
    <select
      className={className}
      autoFocus={autoFocus}
      value={shownValue}
      aria-label="Sales"
      disabled={disabled}
      onChange={(e) => {
        const v = e.target.value;
        if (v === ADD) {
          adding.current = true;
          onChange('');
          setTyping(true);
          return;
        }
        onChange(v);
        onDone?.(v);
      }}
      onBlur={() => { if (!adding.current) onCancel?.(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel?.(); } }}
    >
      <option value="">—</option>
      {value.trim() !== '' && !listed && <option value={value}>{value}</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
      <option value={ADD}>+ Add someone…</option>
    </select>
  );
}

/** The datalist a seat's input suggests from (`ClientTeamDatalists`). */
export const teamListId = (seat: Seat): string => `client-team-people-${seat}`;

/** One set of suggestions for every editable team cell on the page: AM, TL and
    ATL list the people holding that role (Sales is a dropdown, `SalesSelect`). */
export function ClientTeamDatalists({ vocab }: { vocab: ClientTeamsOverview | undefined }) {
  const seats: Exclude<Seat, 'sales'>[] = ['am', 'tl', 'atl'];
  return (
    <>
      {seats.map((s) => (
        <datalist key={s} id={teamListId(s)}>
          {(vocab?.people_by_seat?.[s] ?? []).map((p) => <option key={p} value={p} />)}
        </datalist>
      ))}
    </>
  );
}

/** The Sales dropdown's names; an older API without the list offers House. */
export const salespeopleOf = (v: { salespeople?: string[] } | undefined): string[] => v?.salespeople ?? [CLIENT_TEAM_HOUSE];

/** The five team cells of one client's row. */
export function ClientTeamCells({ clientId, teams, vocab }: {
  clientId: string;
  teams: readonly Line[];
  vocab: ClientTeamsOverview | undefined;
}) {
  const qc = useQueryClient();
  const canEdit = vocab?.can_edit === true;
  const entities = vocab?.billing_entities ?? [];
  const [editing, setEditingState] = useState<Editing | null>(null);
  const editingRef = useRef<Editing | null>(null);
  const setEditing = (e: Editing | null) => {
    editingRef.current = e;
    setEditingState(e);
  };
  const [val, setVal] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: ({ team, col, value }: { team: Line | null; col: Col; value: string }) => {
      const input: ClientTeamInput = {
        billing_entity: team?.billing_entity ?? '',
        tl: team?.tl ?? null,
        atl: team?.atl ?? null,
        sales: team?.sales ?? null,
        am: team?.am ?? null,
      };
      if (col === 'billing_entity') input.billing_entity = value;
      else input[col] = value === '' ? null : value;
      return saveClientTeam(clientId, team ? team.id : null, input);
    },
    onMutate: () => setProblem(null),
    onSuccess: (res) => {
      qc.setQueryData(['client-teams', clientId], res);
      void qc.invalidateQueries({ queryKey: ['client-teams-overview'] });
      void qc.invalidateQueries({ queryKey: ['client-history', clientId] });
      void qc.invalidateQueries({ queryKey: ['wo-create-form'] });
    },
    onError: (e) => setProblem(errText(e, 'Could not save the team.')),
  });

  const start = (teamId: string | 'new', col: Col, old: string) => {
    setVal(old);
    setProblem(null);
    setEditing({ teamId, col, old });
  };
  /** Ends the edit once (Enter, then the blur of the removed input, must not
      save twice) and saves only a change. */
  const commit = (value: string) => {
    const cur = editingRef.current;
    if (!cur) return;
    setEditing(null);
    const next = value.trim();
    if (next === cur.old.trim()) return;
    if (cur.col === 'billing_entity' && next === '') return;
    const team = cur.teamId === 'new' ? null : (teams.find((t) => t.id === cur.teamId) ?? null);
    save.mutate({ team, col: cur.col, value: next });
  };

  const isEditing = (teamId: string | 'new', col: Col) => editing?.teamId === teamId && editing.col === col;

  const compSelect = (teamId: string | 'new', current: string) => {
    const taken = new Set(teams.filter((t) => t.id !== teamId).map((t) => t.billing_entity.toUpperCase()));
    const options = entities.filter((e) => !taken.has(e.toUpperCase()));
    return (
      <select
        className="fld fld-sm client-team-input"
        autoFocus
        value={val}
        aria-label="Comp"
        onChange={(e) => commit(e.target.value)}
        onBlur={() => setEditing(null)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }}
      >
        <option value="">Comp…</option>
        {current && !options.includes(current) && <option value={current}>{current}</option>}
        {options.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
    );
  };

  const nameInput = (col: Seat) => col === 'sales' ? (
    <SalesSelect
      className="fld fld-sm client-team-input"
      autoFocus
      value={val}
      options={salespeopleOf(vocab)}
      onChange={setVal}
      onDone={commit}
      onCancel={() => setEditing(null)}
    />
  ) : (
    <input
      className="fld fld-sm client-team-input"
      autoFocus
      list={teamListId(col)}
      value={val}
      aria-label={LABEL[col]}
      onChange={(e) => setVal(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit((e.target as HTMLInputElement).value); }
        if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); }
      }}
    />
  );

  const shown = (col: Col, raw: string | null) =>
    !raw ? <span className="pf-muted">—</span>
      : col === 'billing_entity' ? <b className="mono">{raw}</b>
      : col === 'sales' && raw.trim().toLowerCase() === CLIENT_TEAM_HOUSE.toLowerCase() ? <span className="pf-muted">{raw}</span>
      : raw;

  return (
    <>
      {COLS.map((col) => (
        <td key={col} className="client-teams-cell">
          {teams.map((t) => {
            const raw = t[col];
            return (
              <span key={t.id} className="client-teams-line">
                {isEditing(t.id, col) ? (
                  col === 'billing_entity' ? compSelect(t.id, raw ?? '') : nameInput(col)
                ) : canEdit ? (
                  <button
                    type="button"
                    className="client-team-cell-btn"
                    disabled={save.isPending}
                    title={`Change the ${LABEL[col]}${col === 'billing_entity' ? '' : ` for ${t.billing_entity}`}`}
                    onClick={() => start(t.id, col, raw ?? '')}
                  >
                    {shown(col, raw)}
                  </button>
                ) : shown(col, raw)}
              </span>
            );
          })}
          {col === 'billing_entity' && canEdit && (
            isEditing('new', 'billing_entity') ? (
              <span className="client-teams-line">{compSelect('new', '')}</span>
            ) : (
              <button
                type="button"
                className="link-btn client-team-add"
                disabled={save.isPending}
                onClick={() => start('new', 'billing_entity', '')}
              >
                + Comp
              </button>
            )
          )}
          {teams.length === 0 && !(col === 'billing_entity' && canEdit) && '—'}
          {col === 'billing_entity' && problem && <span className="client-team-err" role="alert">{problem}</span>}
        </td>
      ))}
    </>
  );
}
