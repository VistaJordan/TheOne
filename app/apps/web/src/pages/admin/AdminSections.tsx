/* Admin Studio — Settings, Workflows, Custom fields, Themes, Trash.
   All read from real data. Where a section is read-only it says so and says
   why, rather than showing controls that would not take effect. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell, AdminEmpty } from './AdminShell';
import { Icon } from '../../components/Icon';
import { useTheme } from '../../theme/ThemeProvider';
import {
  getAdminSettings,
  listAdminFields,
  listAdminWorkflow,
  listTrash,
  restoreFromTrash,
} from '../../api/client';

// ══ SETTINGS ═════════════════════════════════════════════════════════════════

export function AdminSettingsPage() {
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: getAdminSettings, retry: 0 });
  const s = q.data;

  return (
    <AdminShell
      title="Settings"
      subtitle="How this instance is configured. Set by environment and migration — read-only here."
    >
      {q.isLoading && <AdminEmpty icon="sliders" title="Loading settings…" />}
      {q.isError && <AdminEmpty icon="alert" title="Could not load settings" />}

      {s && (
        <div className="setgrid">
          <SetCard title="Authentication" icon="lock">
            <Row k="Mode" v={s.auth.mode === 'entra' ? 'Microsoft Entra ID' : 'Development bypass'}
              tone={s.auth.mode === 'entra' ? 'ok' : 'warn'} />
            <Row k="Access" v="Invitation only" />
            <Row k="Directory" v={s.auth.tenant_id ?? 'Not configured'} mono />
            <Row k="Redirect URI" v={s.auth.redirect_uri ?? '—'} mono />
            <Row k="Session length" v={`${s.auth.session_ttl_hours} hours`} />
            {s.auth.mode === 'bypass' && (
              <p className="set-note">
                <Icon name="alert" size={12} />
                {/* One span, not loose text: .set-note is a flex row, so every
                    <code> here would otherwise become its own flex item and
                    the prose between them would wrap a word per line. */}
                <span>
                  Anyone who can reach the API can sign in as any user. Add{' '}
                  <code>ENTRA_TENANT_ID</code>, <code>ENTRA_CLIENT_ID</code> and{' '}
                  <code>ENTRA_CLIENT_SECRET</code> to <code>app/.env</code> to switch on Microsoft
                  sign-in.
                </span>
              </p>
            )}
          </SetCard>

          <SetCard title="Server" icon="radio">
            <Row k="Environment" v={s.server.node_env} />
            <Row k="Web origin" v={s.server.web_origin} mono />
            <Row k="API port" v={String(s.server.api_port)} mono />
            <Row k="Secure cookies" v={s.server.cookie_secure ? 'Yes (HTTPS)' : 'No (plain HTTP)'}
              tone={s.server.cookie_secure ? 'ok' : undefined} />
          </SetCard>

          <SetCard title="Database" icon="package">
            <Row k="Engine" v={s.database.engine} />
            <Row k="Migrations" v={`${s.database.migrations_applied} applied`} />
            <Row k="Latest" v={s.database.latest_migration ?? '—'} mono />
          </SetCard>

          <SetCard title="Contents" icon="grid">
            <Row k="Work orders" v={s.counts.work_orders.toLocaleString()} />
            <Row k="Users" v={String(s.counts.users)} />
            <Row k="Roles" v={String(s.counts.roles)} />
            <Row k="Statuses" v={String(s.counts.statuses)} />
            <Row k="Custom fields" v={String(s.counts.fields)} />
          </SetCard>
        </div>
      )}
    </AdminShell>
  );
}

function SetCard({ title, icon, children }: { title: string; icon: 'lock' | 'radio' | 'package' | 'grid'; children: React.ReactNode }) {
  return (
    <section className="card set-card">
      <div className="card-head">
        <Icon name={icon} size={14} />
        <h3 className="card-title">{title}</h3>
      </div>
      <dl className="set-list">{children}</dl>
    </section>
  );
}

function Row({ k, v, mono, tone }: { k: string; v: string; mono?: boolean; tone?: 'ok' | 'warn' }) {
  return (
    <div className="set-row">
      <dt>{k}</dt>
      <dd className={`${mono ? 'mono ' : ''}${tone ? `is-${tone}` : ''}`}>{v}</dd>
    </div>
  );
}

// ══ WORKFLOWS ════════════════════════════════════════════════════════════════

const GROUP_LABEL: Record<string, string> = {
  open: 'Open', active: 'Active', done: 'Done', closed: 'Closed',
};

export function AdminWorkflowsPage() {
  const q = useQuery({ queryKey: ['admin-workflow'], queryFn: listAdminWorkflow, retry: 0 });
  const items = q.data?.items ?? [];
  const groups = ['open', 'active', 'done', 'closed'] as const;

  return (
    <AdminShell
      title="Workflows"
      subtitle={`The ${items.length}-status pipeline every work order moves through, in order.`}
    >
      <div className="callout" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span>
          Read-only for now. The KPI tiles match statuses by <b>name</b>, so renaming one here
          would silently break them — editing lands with the rules engine.
        </span>
      </div>

      {q.isLoading && <AdminEmpty icon="swap" title="Loading pipeline…" />}
      {q.isError && <AdminEmpty icon="alert" title="Could not load the pipeline" />}

      {groups.map((g) => {
        const rows = items.filter((s) => s.status_group === g);
        if (rows.length === 0) return null;
        const total = rows.reduce((n, r) => n + r.wo_count, 0);
        return (
          <section className="card wf-group" key={g}>
            <div className="card-head">
              <span className={`sec-badge is-${g}`}>{GROUP_LABEL[g]}</span>
              <span className="sec-sub">{rows.length} status{rows.length === 1 ? '' : 'es'}</span>
              <span className="subtotal-chip push">{total} work order{total === 1 ? '' : 's'}</span>
            </div>
            <ul className="wf-list">
              {rows.map((s) => (
                <li className="wf-row" key={s.id}>
                  <span className="wf-pos">{s.position}</span>
                  <span className="wf-dot" style={{ background: s.color }} aria-hidden="true" />
                  <span className="wf-name">{s.name}</span>
                  {s.is_archive && <span className="chip chip-sm">Archive</span>}
                  <span className="wf-count">{s.wo_count || '—'}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </AdminShell>
  );
}

// ══ CUSTOM FIELDS ════════════════════════════════════════════════════════════

export function AdminFieldsPage() {
  const q = useQuery({ queryKey: ['admin-fields'], queryFn: listAdminFields, retry: 0 });
  const items = q.data?.items ?? [];
  const unused = items.filter((f) => f.used_by === 0).length;

  return (
    <AdminShell
      title="Custom fields"
      subtitle={`${items.length} definitions carried over from ClickUp${unused ? ` · ${unused} not used by any work order` : ''}`}
    >
      <div className="callout" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span>
          Read-only for now. These keys are how the work-order record reads its values, so adding
          and renaming waits on the field engine (roadmap L0). The <b>Used by</b> column is live —
          a field at zero is a candidate to retire.
        </span>
      </div>

      {q.isLoading && <AdminEmpty icon="list" title="Loading fields…" />}
      {q.isError && <AdminEmpty icon="alert" title="Could not load fields" />}

      {items.length > 0 && (
        <div className="table-wrap">
          <table className="ct">
            <thead>
              <tr>
                <th className="num">#</th><th>Field</th><th>Type</th>
                <th className="num">Options</th><th className="num">Used by</th><th>Container</th>
              </tr>
            </thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id} className={f.used_by === 0 ? 'is-dim' : undefined}>
                  <td className="num">{f.position ?? '—'}</td>
                  <td><div className="site"><strong>{f.label}</strong><small className="mono">{f.key}</small></div></td>
                  <td><span className="chip chip-sm">{f.type}</span></td>
                  <td className="num">{f.option_count || '—'}</td>
                  <td className="num">{f.used_by || '—'}</td>
                  <td>{f.container ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}

// ══ THEMES ═══════════════════════════════════════════════════════════════════

const SWATCHES: { token: string; label: string }[] = [
  { token: '--bg', label: 'Background' },
  { token: '--surface', label: 'Surface' },
  { token: '--ink', label: 'Text' },
  { token: '--ink-2', label: 'Muted text' },
  { token: '--accent', label: 'Accent' },
  { token: '--warn-solid', label: 'Warning' },
  { token: '--danger', label: 'Danger' },
  { token: '--border', label: 'Border' },
];

export function AdminThemesPage() {
  const { theme, setTheme } = useTheme();

  return (
    <AdminShell
      title="Themes"
      subtitle="Two brand skins. Your choice is per-browser and applies immediately."
    >
      <div className="theme-picker">
        <ThemeCard
          id="night" name="Blackout" current={theme}
          note="Near-black ground, cyan accent. Built for dispatch floors and long shifts."
          onPick={setTheme}
        />
        <ThemeCard
          id="day" name="Daylight Dispatch" current={theme}
          note="Light neutral ground, deeper accent for contrast. Built for bright offices and print."
          onPick={setTheme}
        />
      </div>

      <section className="card">
        <div className="card-head">
          <h3 className="card-title">Current palette</h3>
          <span className="card-meta">Live values from theme/tokens.css</span>
        </div>
        <div className="swatches card-pad">
          {SWATCHES.map((s) => (
            <div className="swatch" key={s.token}>
              <span className="swatch-chip" style={{ background: `var(${s.token})` }} aria-hidden="true" />
              <span className="swatch-meta">
                <b>{s.label}</b>
                <code>{s.token}</code>
              </span>
            </div>
          ))}
        </div>
        <p className="set-note">
          <Icon name="info" size={12} />
          <span>
            Every colour clears WCAG AA (4.5:1) against its own background in both skins. Adding a
            third theme means adding a token block, not new component CSS.
          </span>
        </p>
      </section>
    </AdminShell>
  );
}

function ThemeCard({ id, name, note, current, onPick }: {
  id: 'night' | 'day'; name: string; note: string;
  current: string; onPick: (t: 'night' | 'day') => void;
}) {
  const active = current === id;
  return (
    <button type="button" className={`theme-card${active ? ' is-active' : ''}`}
      aria-pressed={active} onClick={() => onPick(id)}>
      <span className={`theme-preview is-${id}`} aria-hidden="true">
        <span className="tp-side" /><span className="tp-bar" /><span className="tp-row" /><span className="tp-row short" />
      </span>
      <span className="theme-meta">
        <b>{name} {active && <Icon name="check-circle" size={14} />}</b>
        <small>{note}</small>
      </span>
    </button>
  );
}

// ══ TRASH ════════════════════════════════════════════════════════════════════

export function AdminTrashPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-trash'], queryFn: listTrash, retry: 0 });
  const restore = useMutation({
    mutationFn: restoreFromTrash,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-trash'] });
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
    },
  });

  const items = q.data?.items ?? [];

  return (
    <AdminShell
      title="Trash"
      subtitle="Work orders that were deleted. Nothing is removed permanently — restoring puts one straight back."
    >
      {q.isLoading && <AdminEmpty icon="trash" title="Loading…" />}
      {q.isError && <AdminEmpty icon="alert" title="Could not load the trash" />}

      {!q.isLoading && !q.isError && items.length === 0 && (
        <AdminEmpty icon="trash" title="Nothing in the trash">
          Deleted work orders appear here with a restore button. The app has no delete action yet,
          so this stays empty until one lands — the soft-delete column it reads has been in the
          schema since migration 0001.
        </AdminEmpty>
      )}

      {items.length > 0 && (
        <div className="table-wrap">
          <table className="ct">
            <thead>
              <tr><th>WO #</th><th>Title</th><th>Client</th><th>Status at deletion</th><th>Deleted</th><th /></tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td><span className="wo-num">{t.wo_number}</span></td>
                  <td>{t.title}</td>
                  <td>{t.client ?? '—'}</td>
                  <td>{t.status}</td>
                  <td>{new Date(t.deleted_at).toLocaleDateString()}</td>
                  <td className="num">
                    <button type="button" className="linkbtn" disabled={restore.isPending}
                      onClick={() => restore.mutate(t.id)}>Restore</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
