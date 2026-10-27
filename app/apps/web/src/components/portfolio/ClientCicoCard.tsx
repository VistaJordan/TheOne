/* 0100 · Clients › a client › Check-in method: how a technician checks in on
   this client's work orders under each of our companies (Comp) — the method
   (IVR, Portal, Email …), which portal, the instruction (the IVR number,
   "Picture + manager name") and the mailbox the work is handled from. A new
   visit on a work order takes the row matching its Client and Comp; with no
   row it falls back to the FM table in Admin › Custom fields. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CICO_PORTAL_METHOD, CICO_PORTAL_SUGGESTIONS, VISIT_METHODS } from '@theone/shared';
import type { ClientCicoInput, ClientCicoMethod, ClientCicoResponse } from '@theone/shared';
import { deleteClientCico, getClientCico, saveClientCico } from '../../api/client';
import { Icon } from '../Icon';
import { errText } from './PortfolioParts';

type Draft = Record<'billing_entity' | 'method' | 'portal' | 'detail' | 'email', string>;
const toDraft = (m: ClientCicoMethod | null): Draft => ({
  billing_entity: m?.billing_entity ?? '',
  method: m?.method ?? '',
  portal: m?.portal ?? '',
  detail: m?.detail ?? '',
  email: m?.email ?? '',
});

export function ClientCicoCard({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const key = ['client-cico', clientId];
  const q = useQuery({ queryKey: key, queryFn: () => getClientCico(clientId) });
  // null = no row open; 'new' = the add row; else the row id being edited.
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(toDraft(null));
  const [problem, setProblem] = useState<string | null>(null);
  const done = (res: ClientCicoResponse) => {
    qc.setQueryData(key, res);
    void qc.invalidateQueries({ queryKey: ['client-history', clientId] });
    setOpen(null);
    setProblem(null);
  };
  const save = useMutation({
    mutationFn: () => {
      const input: ClientCicoInput = {
        billing_entity: draft.billing_entity,
        method: draft.method,
        portal: draft.method === CICO_PORTAL_METHOD ? draft.portal || null : null,
        detail: draft.detail || null,
        email: draft.email || null,
      };
      return saveClientCico(clientId, open === 'new' ? null : open, input);
    },
    onSuccess: done,
    onError: (e) => setProblem(errText(e, 'Could not save the check-in method.')),
  });
  const remove = useMutation({
    mutationFn: (rowId: string) => deleteClientCico(clientId, rowId),
    onSuccess: done,
    onError: (e) => setProblem(errText(e, 'Could not remove the check-in method.')),
  });

  const data = q.data;
  const items = data?.items ?? [];
  const busy = save.isPending || remove.isPending;
  const start = (m: ClientCicoMethod | null) => {
    setOpen(m ? m.id : 'new');
    setDraft(toDraft(m));
    setProblem(null);
  };
  const portalList = `client-cico-portals-${clientId}`;
  const portals = [...new Set([...CICO_PORTAL_SUGGESTIONS, ...items.map((m) => m.portal).filter((p): p is string => !!p)])];
  const dash = <span className="pf-muted">—</span>;

  const editRow = (
    <tr key="edit" className="client-team-edit">
      <td>
        <select className="fld" value={draft.billing_entity} onChange={(e) => setDraft({ ...draft, billing_entity: e.target.value })} disabled={busy} aria-label="Comp">
          <option value="">Comp…</option>
          {(data?.billing_entities ?? []).map((b) => <option key={b} value={b}>{b}</option>)}
          {draft.billing_entity && !(data?.billing_entities ?? []).includes(draft.billing_entity) && <option value={draft.billing_entity}>{draft.billing_entity}</option>}
        </select>
      </td>
      <td>
        <select className="fld" value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value })} disabled={busy} aria-label="Method">
          <option value="">Method…</option>
          {VISIT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </td>
      <td>
        <input
          className="fld"
          list={portalList}
          value={draft.method === CICO_PORTAL_METHOD ? draft.portal : ''}
          onChange={(e) => setDraft({ ...draft, portal: e.target.value })}
          disabled={busy || draft.method !== CICO_PORTAL_METHOD}
          placeholder={draft.method === CICO_PORTAL_METHOD ? 'Which portal' : 'Portal only'}
          aria-label="Portal"
        />
      </td>
      <td>
        <input className="fld" value={draft.detail} onChange={(e) => setDraft({ ...draft, detail: e.target.value })} disabled={busy} placeholder="Phone number, instruction…" aria-label="Instruction" />
      </td>
      <td>
        <input className="fld" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} disabled={busy} aria-label="Email" />
      </td>
      <td className="client-team-acts">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || draft.billing_entity === '' || draft.method === ''} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-sm is-ghost" disabled={busy} onClick={() => setOpen(null)}>Cancel</button>
      </td>
    </tr>
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Check-in method</h2>
        <span className="card-meta">{items.length === 1 ? '1 company' : `${items.length} companies`}</span>
        {data?.can_edit && open === null && (
          <button type="button" className="btn btn-sm is-ghost" onClick={() => start(null)}>
            <Icon name="plus" size={12} />Add method
          </button>
        )}
      </div>
      <p className="hint client-team-hint">A new visit takes the method for the work order’s Comp. With none here it falls back to the FM’s entry in Admin › Custom fields.</p>
      {q.isLoading ? (
        <div className="empty-flat">Loading…</div>
      ) : q.isError ? (
        <div className="empty-flat">{errText(q.error, 'Could not load the check-in method.')}</div>
      ) : items.length === 0 && open !== 'new' ? (
        <div className="empty-flat">No check-in method on file for this client.</div>
      ) : (
        <div className="vend-wrap">
          <table className="vend-table client-team-table">
            <thead>
              <tr><th>Comp</th><th>Method</th><th>Portal</th><th>Instruction</th><th>Email</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {items.map((m) =>
                open === m.id ? editRow : (
                  <tr key={m.id}>
                    <td className="mono"><b>{m.billing_entity}</b></td>
                    <td>{m.method}</td>
                    <td>{m.portal ?? dash}</td>
                    <td>{m.detail ?? dash}</td>
                    <td>{m.email ?? dash}</td>
                    <td className="client-team-acts">
                      {data?.can_edit && open === null && (
                        <>
                          <button type="button" className="link-btn" disabled={busy} onClick={() => start(m)}>Edit</button>
                          <button type="button" className="link-btn" disabled={busy} onClick={() => remove.mutate(m.id)}>Remove</button>
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
      <datalist id={portalList}>
        {portals.map((p) => <option key={p} value={p} />)}
      </datalist>
      {problem && <p className="modal-error" role="alert">{problem}</p>}
    </section>
  );
}
