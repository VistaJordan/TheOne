// 0071 · Admin › Settings › SharePoint folders. The site and library, the
// path templates, the three switches (client folders, work-order folders,
// copy approved files), what has been filed so far, and two buttons: Test
// connection and Run now. Credentials live in the environment, never here.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SHAREPOINT_DEFAULTS, type SharePointFolderKind, type SharePointSettings, type SharePointTestResult } from '@theone/shared';
import { Icon } from '../../components/Icon';
import {
  ApiRequestError,
  getSharePointOverview,
  runSharePoint,
  saveSharePointSettings,
  testSharePoint,
  type SharePointRunResult,
} from '../../api/client';

type Draft = Pick<SharePointSettings, 'site_url' | 'library' | 'root_path' | 'entity_folder' | 'wo_folder'>;

const KIND_LABEL: Record<SharePointFolderKind, string> = { client: 'Client folders', work_order: 'Work-order folders' };

function draftOf(s: SharePointSettings): Draft {
  return { site_url: s.site_url, library: s.library, root_path: s.root_path, entity_folder: s.entity_folder, wo_folder: s.wo_folder };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    (a.site_url ?? '') === (b.site_url ?? '') &&
    a.library === b.library &&
    a.root_path === b.root_path &&
    a.entity_folder === b.entity_folder &&
    a.wo_folder === b.wo_folder
  );
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function SharePointCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-sharepoint'], queryFn: getSharePointOverview, retry: 0 });
  const o = q.data;
  const s = o?.settings;
  const canEdit = o?.can_edit ?? false;

  const [draft, setDraft] = useState<Draft>(draftOf(SHAREPOINT_DEFAULTS));
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<SharePointTestResult | null>(null);
  const [run, setRun] = useState<SharePointRunResult | null>(null);
  useEffect(() => {
    if (s) setDraft(draftOf(s));
  }, [s]);

  const done = () => {
    setError(null);
    void qc.invalidateQueries({ queryKey: ['admin-sharepoint'] });
  };
  const fail = (err: unknown) => setError(err instanceof ApiRequestError ? err.message : 'The change did not save');
  const save = useMutation({
    mutationFn: (patch: Partial<SharePointSettings>) => saveSharePointSettings(patch),
    onSuccess: done,
    onError: fail,
  });
  const testM = useMutation({
    mutationFn: testSharePoint,
    onSuccess: (r) => { setError(null); setTest(r); },
    onError: (e) => setTest({ ok: false, error: e instanceof ApiRequestError ? e.message : 'The test did not run' }),
  });
  const runM = useMutation({
    mutationFn: runSharePoint,
    onSuccess: (r) => { setRun(r); done(); },
    onError: fail,
  });
  const busy = save.isPending || testM.isPending || runM.isPending;
  const dirty = s ? !sameDraft(draft, draftOf(s)) : false;

  const toggle = (key: 'client_folders' | 'wo_folders' | 'copy_files', label: string, note: string) => (
    <label className={`sp-switch${s?.[key] ? ' is-on' : ''}`}>
      <input
        type="checkbox"
        checked={s?.[key] ?? false}
        disabled={busy || !canEdit || !s}
        onChange={(e) => save.mutate({ [key]: e.target.checked })}
      />
      <span className="sp-switch-text">
        <b>{label}</b>
        <span className="hint">{note}</span>
      </span>
      {s?.[key] && s[`${key}_since`] && <span className="sp-since">on since {when(s[`${key}_since`] as string)}</span>}
    </label>
  );

  const field = (key: keyof Draft, label: string, hint: string, placeholder?: string, mono = true) => (
    <label className="field">
      <span className="lbl">{label}</span>
      <input
        className={`fld${mono ? ' mono' : ''}`}
        value={draft[key] ?? ''}
        placeholder={placeholder}
        disabled={busy || !canEdit}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
      />
      <span className="hint">{hint}</span>
    </label>
  );

  const conn = o?.connection;
  const counts = o?.counts;
  const files = o?.files;

  return (
    <section className="card adm-cico sp-card">
      <div className="card-head">
        <Icon name="ext" size={14} />
        <h3 className="card-title">SharePoint folders</h3>
        <span className="card-meta">
          {conn?.ready ? 'connected' : conn?.credentials ? 'site not set' : conn?.site ? 'credentials not set' : 'not set up'}
        </span>
      </div>
      <p className="adm-cico-note">
        One folder per client under its billing entity, one per work order under the client, and the approved
        files of a work order copied into its folder — the tree the team already keeps:{' '}
        <code>Documents / General / Work Orders - 2026 / 2026 - SFM / Bashas / WO#345437406, Phoenix, AZ</code>.
        Each switch files only what is created after it is turned on. Nothing is ever deleted or renamed in SharePoint.
      </p>

      {q.isLoading && <div className="empty-flat">Loading…</div>}
      {q.isError && <div className="empty-flat">Could not load — GET /api/admin/sharepoint did not respond.</div>}

      {error && (
        <div className="callout adm-cico-err" role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </div>
      )}

      {o && s && (
        <>
          <dl className="set-list sp-conn">
            <div className="set-row">
              <dt>Credentials</dt>
              <dd className={conn?.credentials ? 'is-ok' : 'is-warn'}>
                {conn?.credentials
                  ? 'Set on the server'
                  : 'Not set — add SHAREPOINT_TENANT_ID, SHAREPOINT_CLIENT_ID and SHAREPOINT_CLIENT_SECRET to the server environment'}
              </dd>
            </div>
            <div className="set-row">
              <dt>Site</dt>
              <dd className={conn?.site ? 'is-ok' : 'is-warn'}>{conn?.site ? s.site_url : 'No site URL yet'}</dd>
            </div>
          </dl>

          <form
            className="sp-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty) save.mutate(draft);
            }}
          >
            {field('site_url', 'Site URL', 'The SharePoint site that holds the library.', 'https://yourtenant.sharepoint.com/sites/SeamlessFM')}
            {field('library', 'Library', 'The document library on that site, by name.', 'Documents')}
            {field('root_path', 'Year folder', '{year} is replaced. Folders along the way are made when missing.')}
            {field('entity_folder', 'Billing-entity folder', '{year} and {entity} — the work order’s 21. Comp — are replaced.')}
            {field('wo_folder', 'Work-order folder', '{number}, {city} and {state} are replaced; a missing city or state is dropped. ECO- work orders use their Ecotrak number.')}
            <div className="sp-form-actions">
              <button type="submit" className="btn btn-primary" disabled={busy || !canEdit || !dirty}>
                <Icon name="check" size={14} />
                Save
              </button>
              {dirty && (
                <button type="button" className="btn" disabled={busy} onClick={() => setDraft(draftOf(s))}>
                  Discard
                </button>
              )}
              <button type="button" className="btn" disabled={busy || !conn?.credentials || !conn?.site} onClick={() => testM.mutate()}>
                <Icon name="plug" size={14} />
                {testM.isPending ? 'Testing…' : 'Test connection'}
              </button>
              <button type="button" className="btn" disabled={busy || !canEdit || !conn?.ready} onClick={() => runM.mutate()}>
                <Icon name="refresh" size={14} />
                {runM.isPending ? 'Running…' : 'Run now'}
              </button>
            </div>
          </form>

          {test && (
            <div className={`callout ${test.ok ? 'sp-ok' : 'adm-cico-err'}`} role="status">
              <Icon name={test.ok ? 'check-circle' : 'alert'} size={14} />
              <span>
                {test.ok ? (
                  <>
                    Connected to <b>{test.site_name}</b> › <b>{test.library_name}</b>.{' '}
                    {test.root_web_url && (
                      <a href={test.root_web_url} target="_blank" rel="noopener noreferrer">Open the library</a>
                    )}
                  </>
                ) : (
                  test.error
                )}
              </span>
            </div>
          )}
          {run && (
            <div className="callout sp-ok" role="status">
              <Icon name="check-circle" size={14} />
              <span>
                {run.skipped === 'off'
                  ? 'Nothing to do — every switch is off.'
                  : run.skipped === 'not_ready'
                    ? 'Nothing ran — SharePoint is not connected yet.'
                    : `Folders: ${run.folders_created} made of ${run.folders_tried} tried · Files: ${run.files_copied} copied of ${run.files_tried} tried.`}
              </span>
            </div>
          )}

          <div className="sp-switches">
            {toggle('client_folders', 'A folder for each new client', 'Under its billing entity, when a client is added under Clients. A client without a billing entity is not filed.')}
            {toggle('wo_folders', 'A folder for each new work order', 'Under the client, whichever way the work order is created (form, intake, planned maintenance, import, sync). The client must be on file under Clients.')}
            {toggle('copy_files', 'Copy approved files into the work-order folder', 'Photos and files go in once a reviewer approves them; nothing in quarantine leaves the app.')}
          </div>

          {counts && files && (
            <div className="table-wrap">
              <table className="ct adm-cico-ct sp-counts">
                <thead>
                  <tr>
                    <th>Filed so far</th>
                    <th className="num">Made</th>
                    <th className="num">Waiting</th>
                    <th className="num">Failed</th>
                    <th className="num">Not filed</th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(KIND_LABEL) as SharePointFolderKind[]).map((k) => (
                    <tr key={k}>
                      <td><b>{KIND_LABEL[k]}</b></td>
                      <td className="num">{counts[k].created}</td>
                      <td className="num">{counts[k].pending}</td>
                      <td className={`num${counts[k].failed ? ' is-warn' : ''}`}>{counts[k].failed}</td>
                      <td className="num">{counts[k].skipped}</td>
                    </tr>
                  ))}
                  <tr>
                    <td><b>Files copied</b></td>
                    <td className="num">{files.copied}</td>
                    <td className="num">{files.pending}</td>
                    <td className={`num${files.failed ? ' is-warn' : ''}`}>{files.failed}</td>
                    <td className="num">{files.skipped}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {o.recent_failures.length > 0 && (
            <div className="table-wrap">
              <table className="ct adm-cico-ct">
                <thead>
                  <tr>
                    <th>Could not be filed</th>
                    <th>Why</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {o.recent_failures.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <b>{f.entity_name}</b>
                        <span className="hint"> · {f.kind === 'client' ? 'client' : 'work order'}{f.attempts > 1 ? ` · ${f.attempts} tries` : ''}</span>
                      </td>
                      <td>{f.error ?? '—'}</td>
                      <td className="num">{when(f.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint sp-hint">
                A failed row is tried again every hour, up to six times; Run now gives every failed row its tries back.
                A work order whose client is not on file is filed once the client is added.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
