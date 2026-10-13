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
import { getEcotrak, syncEcotrakNow } from '../../api/client';
import { Icon } from '../../components/Icon';
import { errText } from '../../components/ui/Sheet';

const KEY = ['admin', 'integrations', 'ecotrak'];

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

export function EcotrakPanel({ canEdit, enabled }: { canEdit: boolean; enabled: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: [...KEY, enabled], queryFn: getEcotrak, retry: false });
  const [error, setError] = useState<string | null>(null);

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
        {d.enabled
          ? 'On: The One reads Ecotrak every 10 minutes. It only reads; nothing is changed on Ecotrak.'
          : 'Off: The One does not contact Ecotrak at all. Turn the switch on to start reading.'}
      </p>
      <div className="cu-stats">
        <span>
          <b>{d.linked}</b> work order{d.linked === 1 ? '' : 's'} from Ecotrak
        </span>
        <span className="cu-run">Last look {when(run?.at ?? d.last_synced_at)}{run ? ` (${run.trigger === 'cron' ? 'automatic' : 'Sync now'})` : ''}</span>
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
