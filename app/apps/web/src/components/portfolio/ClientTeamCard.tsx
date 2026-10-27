/* 0096 · Clients › a client › Account team: who leads this client under each
   of our companies (Comp) — Team Lead, Assistant Team Lead, salesperson,
   Account Manager. "Add work order" fills AM, TL and ATL from the row that
   matches its Client and Comp. Names are kept as typed (the team sheet uses
   first names; "House" = no salesperson); a name that matches one active
   person is shown with the account it stands for, so a typo shows here before
   it shows on a work order. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CLIENT_TEAM_HOUSE, resolvePersonName } from '@theone/shared';
import type { ClientTeam, ClientTeamInput, ClientTeamsResponse } from '@theone/shared';
import { deleteClientTeam, getClientTeams, saveClientTeam } from '../../api/client';
import { Icon } from '../Icon';
import { errText } from './PortfolioParts';

type Draft = Record<'billing_entity' | 'tl' | 'atl' | 'sales' | 'am', string>;
const COLS: { key: Exclude<keyof Draft, 'billing_entity'>; label: string }[] = [
  { key: 'tl', label: 'Team Lead' },
  { key: 'atl', label: 'Assistant TL' },
  { key: 'sales', label: 'Sales' },
  { key: 'am', label: 'AM' },
];
const toDraft = (t: ClientTeam | null): Draft => ({
  billing_entity: t?.billing_entity ?? '',
  tl: t?.tl ?? '',
  atl: t?.atl ?? '',
  sales: t?.sales ?? '',
  am: t?.am ?? '',
});

export function ClientTeamCard({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const key = ['client-teams', clientId];
  const q = useQuery({ queryKey: key, queryFn: () => getClientTeams(clientId) });
  // null = no row open; 'new' = the add row; else the team id being edited.
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(toDraft(null));
  const [problem, setProblem] = useState<string | null>(null);
  const done = (res: ClientTeamsResponse) => {
    qc.setQueryData(key, res);
    void qc.invalidateQueries({ queryKey: ['client-history', clientId] });
    void qc.invalidateQueries({ queryKey: ['wo-create-form'] });
    setOpen(null);
    setProblem(null);
  };
  const save = useMutation({
    mutationFn: () => {
      const input: ClientTeamInput = {
        billing_entity: draft.billing_entity,
        tl: draft.tl || null,
        atl: draft.atl || null,
        sales: draft.sales || null,
        am: draft.am || null,
      };
      return saveClientTeam(clientId, open === 'new' ? null : open, input);
    },
    onSuccess: done,
    onError: (e) => setProblem(errText(e, 'Could not save the team.')),
  });
  const remove = useMutation({
    mutationFn: (teamId: string) => deleteClientTeam(clientId, teamId),
    onSuccess: done,
    onError: (e) => setProblem(errText(e, 'Could not remove the team.')),
  });

  const data = q.data;
  const people = data?.people ?? [];
  const teams = data?.teams ?? [];
  const busy = save.isPending || remove.isPending;
  const start = (t: ClientTeam | null) => {
    setOpen(t ? t.id : 'new');
    setDraft(toDraft(t));
    setProblem(null);
  };
  const listId = `client-team-people-${clientId}`;

  /** A stored name, with the account it stands for when that differs. */
  const shown = (raw: string | null, k: string) => {
    if (!raw) return <span className="pf-muted">—</span>;
    if (k === 'sales' && raw.trim().toLowerCase() === CLIENT_TEAM_HOUSE.toLowerCase()) return <span className="pf-muted">{raw}</span>;
    const who = resolvePersonName(raw, people);
    if (!who) {
      return k === 'sales' ? <>{raw}</> : (
        <span title="No single active account answers to this name, so Add work order leaves the field empty">
          {raw} <Icon name="alert" size={12} />
        </span>
      );
    }
    return who.toLowerCase() === raw.trim().toLowerCase() ? <>{who}</> : <span title={`Stands for ${who}`}>{raw} <span className="pf-muted">· {who}</span></span>;
  };

  const editRow = (
    <tr key="edit" className="client-team-edit">
      <td>
        <select className="fld" value={draft.billing_entity} onChange={(e) => setDraft({ ...draft, billing_entity: e.target.value })} disabled={busy} aria-label="Comp">
          <option value="">Comp…</option>
          {(data?.billing_entities ?? []).map((b) => <option key={b} value={b}>{b}</option>)}
          {draft.billing_entity && !(data?.billing_entities ?? []).includes(draft.billing_entity) && <option value={draft.billing_entity}>{draft.billing_entity}</option>}
        </select>
      </td>
      {COLS.map((c) => (
        <td key={c.key}>
          <input className="fld" list={listId} value={draft[c.key]} onChange={(e) => setDraft({ ...draft, [c.key]: e.target.value })} disabled={busy} aria-label={c.label} />
        </td>
      ))}
      <td className="client-team-acts">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || draft.billing_entity === ''} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-sm is-ghost" disabled={busy} onClick={() => setOpen(null)}>Cancel</button>
      </td>
    </tr>
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Account team</h2>
        <span className="card-meta">{teams.length === 1 ? '1 company' : `${teams.length} companies`}</span>
        {data?.can_edit && open === null && (
          <button type="button" className="btn btn-sm is-ghost" onClick={() => start(null)}>
            <Icon name="plus" size={12} />Add team
          </button>
        )}
      </div>
      <p className="hint client-team-hint">Add work order fills AM, TL and ATL from the row for the work order’s Comp. The dispatcher is always picked by hand.</p>
      {q.isLoading ? (
        <div className="empty-flat">Loading…</div>
      ) : q.isError ? (
        <div className="empty-flat">{errText(q.error, 'Could not load the account team.')}</div>
      ) : teams.length === 0 && open !== 'new' ? (
        <div className="empty-flat">No account team on file for this client.</div>
      ) : (
        <div className="vend-wrap">
          <table className="vend-table client-team-table">
            <thead>
              <tr><th>Comp</th>{COLS.map((c) => <th key={c.key}>{c.label}</th>)}<th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {teams.map((t) =>
                open === t.id ? editRow : (
                  <tr key={t.id}>
                    <td className="mono"><b>{t.billing_entity}</b></td>
                    {COLS.map((c) => <td key={c.key}>{shown(t[c.key], c.key)}</td>)}
                    <td className="client-team-acts">
                      {data?.can_edit && open === null && (
                        <>
                          <button type="button" className="link-btn" disabled={busy} onClick={() => start(t)}>Edit</button>
                          <button type="button" className="link-btn" disabled={busy} onClick={() => remove.mutate(t.id)}>Remove</button>
                        </>
                      )}
                    </td>
                  </tr>
                ),
              )}
              {open === 'new' && editRow}
            </tbody>
          </table>
        </div>
      )}
      <datalist id={listId}>
        {people.map((p) => <option key={p} value={p} />)}
        <option value={CLIENT_TEAM_HOUSE} />
      </datalist>
      {problem && <p className="modal-error" role="alert">{problem}</p>}
    </section>
  );
}
