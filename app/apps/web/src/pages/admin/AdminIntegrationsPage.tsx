/* Admin › Integrations (0074).
 *
 * Everything The One connects to, one row each: the tool's mark, what it
 * does for the team, whether it is set up on the server, and ONE switch.
 * Off = every button that uses the connector stops, with the reason shown
 * where the button was; the keys and secrets stay on the server untouched,
 * so turning it back on needs nothing else.
 *
 * The list itself is code (packages/shared/src/integrations.ts): a connector
 * is code, so a new one appears here when it is built.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { INTEGRATION_GROUPS, INTEGRATION_GROUP_LABELS, adminPermKey } from '@theone/shared';
import type { IntegrationStatus, IntegrationsResponse } from '@theone/shared';
import { getIntegrations, setIntegrationEnabled } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../../components/Icon';
import { errText } from '../../components/ui/Sheet';
import { AdminShell } from './AdminShell';

const KEY = ['admin', 'integrations'];

export function AdminIntegrationsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: getIntegrations, retry: false });
  const [error, setError] = useState<string | null>(null);
  const canEdit = can(adminPermKey('integrations'), 'edit') && q.data?.can.edit !== false;

  const flip = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) => setIntegrationEnabled(key, enabled),
    onMutate: ({ key, enabled }) => {
      setError(null);
      // Draw the switch where it is going before the server answers.
      qc.setQueryData<IntegrationsResponse>(KEY, (cur) =>
        cur ? { ...cur, items: cur.items.map((i) => (i.key === key ? { ...i, enabled } : i)) } : cur,
      );
    },
    onSuccess: (res) => qc.setQueryData(KEY, res),
    onError: (e) => {
      setError(errText(e, 'Could not change the switch.'));
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });

  const items = q.data?.items ?? [];
  const on = items.filter((i) => i.enabled).length;

  return (
    <AdminShell
      title="Integrations"
      subtitle={
        <>
          Everything The One connects to. Turn one off and every button that uses it stops, with the reason shown where the
          button was; the keys and secrets stay on the server, so turning it back on needs nothing else.
          {items.length > 0 && <> {on} of {items.length} on.</>}
        </>
      }
    >
      {error && (
        <div className="callout intg-err" role="alert">
          <Icon name="alert-circle" size={14} /> {error}
        </div>
      )}
      {q.isError && !q.data && (
        <div className="wo-state">
          <Icon name="lock" size={22} />
          <b>Could not load the integrations</b>
          <span>{errText(q.error, 'Try again in a moment.')}</span>
        </div>
      )}
      {INTEGRATION_GROUPS.map((g) => {
        const rows = items.filter((i) => i.group === g);
        if (rows.length === 0) return null;
        return (
          <section key={g} className="card intg-group">
            <div className="card-head">
              <h3 className="card-title">{INTEGRATION_GROUP_LABELS[g]}</h3>
              <span className="card-meta">{rows.filter((r) => r.enabled).length} of {rows.length} on</span>
            </div>
            <ul className="intg-list">
              {rows.map((it) => (
                <IntegrationRow key={it.key} it={it} canEdit={canEdit} busy={flip.isPending && flip.variables?.key === it.key} onFlip={(enabled) => flip.mutate({ key: it.key, enabled })} />
              ))}
            </ul>
          </section>
        );
      })}
    </AdminShell>
  );
}

function stateOf(it: IntegrationStatus): { label: string; tone: 'ok' | 'warn' | 'off' | 'muted' } {
  if (!it.enabled) return { label: 'Off', tone: 'off' };
  if (!it.built) return { label: 'Connector not built yet', tone: 'muted' };
  if (it.configured) return { label: 'Connected', tone: 'ok' };
  return { label: 'On · not set up on the server', tone: 'warn' };
}

const changedText = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function IntegrationRow({ it, canEdit, busy, onFlip }: { it: IntegrationStatus; canEdit: boolean; busy: boolean; onFlip: (enabled: boolean) => void }) {
  const [imgOk, setImgOk] = useState(true);
  const s = stateOf(it);
  const locked = Boolean(it.locked);
  return (
    <li className={`intg-row${it.enabled ? ' is-on' : ' is-off'}`}>
      <div className="intg-logo" aria-hidden="true">
        {imgOk ? (
          <img src={`/brand/integrations/${it.logo}`} alt="" width={44} height={44} onError={() => setImgOk(false)} />
        ) : (
          <span className="intg-mono">{it.name.slice(0, 1)}</span>
        )}
      </div>
      <div className="intg-text">
        <div className="intg-name">
          <b>{it.name}</b>
          <small>{it.vendor}</small>
          <span className={`chip chip-sm intg-state is-${s.tone}`}>{s.label}</span>
        </div>
        <p className="intg-summary">{it.summary}</p>
        {it.configured_note && <p className={`intg-note${it.configured || !it.built ? '' : ' is-warn'}`}>{it.configured_note}</p>}
        <p className="intg-off">
          <b>When off:</b> {it.off_means}
        </p>
        {it.changed_by && it.changed_at && (
          <p className="intg-changed">
            Changed by {it.changed_by.name} · {changedText(it.changed_at)}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={it.enabled}
        aria-label={`${it.name}: ${it.enabled ? 'on' : 'off'}`}
        className={`intg-switch${it.enabled ? ' is-on' : ''}`}
        disabled={!canEdit || locked || busy}
        title={locked ? 'Always on' : canEdit ? (it.enabled ? 'Turn off' : 'Turn on') : 'Only Admin › Integrations editors can change this'}
        onClick={() => onFlip(!it.enabled)}
      >
        <span className="intg-track"><span className="intg-knob" /></span>
        <span className="intg-switch-label">{locked ? 'Always on' : it.enabled ? 'On' : 'Off'}</span>
      </button>
    </li>
  );
}
