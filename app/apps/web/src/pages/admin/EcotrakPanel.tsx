/* 0079 · Ecotrak → The One's panel, under its row in Admin › Integrations.
 *
 * What an administrator needs before and after turning it on: are the
 * credentials on the server, when did it last look at Ecotrak, what did that
 * look bring in (new work orders land in Incoming Work Orders), and a Sync
 * now button. Read only against Ecotrak: nothing here can change what the
 * client sees there.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EcotrakOverview } from '@theone/shared';
import { getEcotrak, registerEcotrakWebhooks, syncEcotrakNow } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { errText } from '../../components/ui/Sheet';

const KEY = ['admin', 'integrations', 'ecotrak'];

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

export function EcotrakPanel({ canEdit, enabled }: { canEdit: boolean; enabled: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: [...KEY, enabled], queryFn: getEcotrak, retry: false });
  const [error, setError] = useState<string | null>(null);
  const [confirmHooks, setConfirmHooks] = useState(false);
  const [hookNote, setHookNote] = useState<string | null>(null);
  const { user, isImpersonating } = useAuth();
  const mayRegister = Boolean(user?.is_super_admin) && !isImpersonating;

  // 0114 · the one write to Ecotrak: our own webhook settings there.
  const hooks = useMutation({
    mutationFn: registerEcotrakWebhooks,
    onMutate: () => {
      setError(null);
      setHookNote(null);
    },
    onSuccess: (res) => {
      qc.setQueryData<EcotrakOverview>([...KEY, enabled], res.overview);
      setConfirmHooks(false);
      const say: Record<string, string> = {
        registered: 'registered',
        already_ours: 'already registered',
        already_on_ecotrak: 'already on Ecotrak, left as it is',
        failed: 'failed',
      };
      setHookNote(
        res.outcomes
          .map((o) => `${o.action === 'WEBHOOK_WORKORDER_COMMENT' ? 'Comments' : 'Work order changes'}: ${say[o.result]}${o.detail && o.result === 'failed' ? ` (${o.detail})` : ''}`)
          .join(' · '),
      );
    },
    onError: (e) => {
      setConfirmHooks(false);
      setError(errText(e, 'The webhooks were not registered.'));
    },
  });

  const sync = useMutation({
    mutationFn: syncEcotrakNow,
    onMutate: () => setError(null),
    onSuccess: (res) => {
      qc.setQueryData<EcotrakOverview>([...KEY, enabled], res.overview);
      void qc.invalidateQueries({ queryKey: ['admin', 'integrations'], exact: true });
    },
    onError: (e) => setError(errText(e, 'The sync did not finish.')),
  });

  if (q.isError && !q.data) {
    return <p className="intg-note is-warn cu-panel">{errText(q.error, 'Could not load the Ecotrak sync.')}</p>;
  }
  const d = q.data;
  if (!d) return <p className="intg-note cu-panel">Loading Ecotrak…</p>;
  const run = d.last_run;
  const wh = d.webhooks;
  const hooksOn = (wh?.registered.length ?? 0) >= 2;

  return (
    <div className="cu-panel">
      {error && (
        <div className="callout intg-err" role="alert">
          <Icon name="alert-circle" size={14} /> {error}
        </div>
      )}
      {!d.credentials_set && (
        <p className="intg-note is-warn">
          The Ecotrak credentials (<code>ECOTRAK_TOKEN_URL</code>, <code>ECOTRAK_BASE_URL</code>, <code>ECOTRAK_CLIENT_ID</code>,{' '}
          <code>ECOTRAK_CLIENT_SECRET</code>) are not on this server.
        </p>
      )}
      <p className="intg-note">
        {!d.enabled
          ? 'Off: The One does not contact Ecotrak at all. Turn the switch on to start reading.'
          : hooksOn
            ? 'On: Ecotrak tells The One the moment a work order changes or gets a comment, and The One also reads Ecotrak every 15 minutes in case a call was missed. It only reads; nothing is changed on Ecotrak.'
            : 'On: The One reads Ecotrak every minute. It only reads; nothing is changed on Ecotrak.'}
      </p>
      <div className="cu-stats">
        <span>
          <b>{d.linked}</b> work order{d.linked === 1 ? '' : 's'} from Ecotrak
        </span>
        <span className="cu-run">Last look {when(run?.at ?? d.last_synced_at)}{run ? ` (${run.trigger === 'cron' ? 'automatic' : run.trigger === 'webhook' ? 'Ecotrak called' : 'Sync now'})` : ''}</span>
        {canEdit && d.enabled && d.credentials_set && (
          <button type="button" className="btn btn-sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
            <Icon name="refresh" size={14} /> {sync.isPending ? 'Reading Ecotrak…' : 'Sync now'}
          </button>
        )}
      </div>
      {run && (
        <p className={`intg-note${run.ok ? '' : ' is-warn'}`}>
          {run.note}
          {run.created > 0 && (
            <>
              {' '}
              <Link to="/incoming">Open Incoming Work Orders</Link>
            </>
          )}
        </p>
      )}
      {wh && (
        <div className="cu-stats">
          <span>
            <b>Webhooks</b>{' '}
            {hooksOn
              ? `on · ${wh.deliveries_24h} call${wh.deliveries_24h === 1 ? '' : 's'} from Ecotrak in 24 h · last ${when(wh.last_delivery_at)}`
              : wh.registered.length === 1
                ? 'one of two registered'
                : 'not registered'}
          </span>
          {!hooksOn && mayRegister && d.enabled && d.credentials_set && wh.url && (
            <button type="button" className="btn btn-sm" disabled={hooks.isPending} onClick={() => setConfirmHooks(true)}>
              <Icon name="plug" size={14} /> Register webhooks
            </button>
          )}
        </div>
      )}
      {wh && !hooksOn && !wh.url && (
        <p className="intg-note">Webhooks need this app’s public https address; they can only be registered from the live site.</p>
      )}
      {hookNote && <p className="intg-note">{hookNote}</p>}
      {confirmHooks && (
        <ConfirmDialog
          title="Register the Ecotrak webhooks?"
          message={
            <>
              Ecotrak will call <code>{wh?.url}</code> whenever one of our work orders changes or gets a comment, and The
              One will read that work order back.
            </>
          }
          note="This adds two webhooks to our own integration settings on Ecotrak. It does not change any work order, comment or anything our clients see, and it never edits or removes a webhook that is already there."
          noteTone="info"
          confirmLabel="Register webhooks"
          busyLabel="Registering…"
          busy={hooks.isPending}
          onCancel={() => setConfirmHooks(false)}
          onConfirm={() => hooks.mutate()}
        />
      )}
      {run && run.errors.length > 0 && (
        <ul className="intg-note is-warn">
          {run.errors.slice(0, 5).map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
