// 0071 · The SharePoint folder of a work order or a client, as a chip: a link
// to open it once it exists, its state while it does not, and — when the
// site is connected — a button to make it now whatever the Settings switch
// says. Draws nothing at all while SharePoint is not set up and the record
// was never filed, so a tenant without it sees no dead control.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { describeSharePointStatus, type SharePointFolderRef } from '@theone/shared';
import {
  ApiRequestError,
  createClientSharePointFolder,
  createWoSharePointFolder,
  getClientSharePointFolder,
  getWoSharePointFolder,
} from '../api/client';
import { Icon } from './Icon';

interface Props {
  kind: 'work_order' | 'client';
  id: string;
}

export function SharePointFolderChip({ kind, id }: Props) {
  const qc = useQueryClient();
  const key = ['sharepoint-folder', kind, id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => (kind === 'work_order' ? getWoSharePointFolder(id) : getClientSharePointFolder(id)),
    retry: 0,
    staleTime: 30_000,
  });
  const [error, setError] = useState<string | null>(null);
  const make = useMutation({
    mutationFn: () => (kind === 'work_order' ? createWoSharePointFolder(id) : createClientSharePointFolder(id)),
    onSuccess: (res) => {
      setError(null);
      qc.setQueryData(key, (prev: { folder: SharePointFolderRef | null; enabled: boolean; ready: boolean } | undefined) =>
        prev ? { ...prev, folder: res.folder } : prev,
      );
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setError(e instanceof ApiRequestError ? e.message : 'The folder could not be made'),
  });

  if (!q.data) return null;
  const { folder, ready } = q.data;
  if (!folder && !ready) return null;

  if (folder?.status === 'created' && folder.web_url) {
    return (
      <a
        className="chip chip-folder"
        href={folder.web_url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open the SharePoint folder — ${folder.path}`}
      >
        <Icon name="ext" size={12} />
        SharePoint folder
      </a>
    );
  }

  const label = folder ? describeSharePointStatus(folder) : null;
  const tone = folder?.status === 'failed' ? ' chip-warn' : folder?.status === 'skipped' ? ' chip-outline' : '';
  const canMake = ready && (!folder || folder.status === 'failed' || folder.status === 'pending' || folder.status === 'skipped');
  return (
    <span className={`chip chip-folder${tone}`} title={error ?? folder?.error ?? (folder ? folder.path : 'No SharePoint folder yet')}>
      <Icon name={folder?.status === 'failed' ? 'alert' : 'ext'} size={12} />
      {label ?? 'No SharePoint folder'}
      {canMake && (
        <button
          type="button"
          className="chip-act"
          disabled={make.isPending}
          onClick={() => make.mutate()}
          aria-label={folder ? 'Try to make the SharePoint folder again' : 'Make the SharePoint folder now'}
        >
          {make.isPending ? 'Making…' : folder ? 'Retry' : 'Make it'}
        </button>
      )}
    </span>
  );
}
