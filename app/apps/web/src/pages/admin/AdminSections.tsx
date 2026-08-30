/* Admin Studio — Settings, Workflows, Custom fields, Themes, Trash.
   All read from real data. Where a section is read-only it says so and says
   why, rather than showing controls that would not take effect. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell, AdminEmpty } from './AdminShell';
import { Icon } from '../../components/Icon';
import { useTheme } from '../../theme/ThemeProvider';
import { useReorder } from '../../hooks/useReorder';
import {
  ApiRequestError,
  createAdminField,
  getAdminSettings,
  listAdminFields,
  listAdminWorkflow,
  listTrash,
  reorderAdminFields,
  restoreFromTrash,
  updateAdminField,
  type AdminFieldItem,
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

// ══ CUSTOM FIELDS (S7 — the field engine) ════════════════════════════════════

/** Every type an admin can pick. Labels are the operator's vocabulary; values
    are the field_type enum. `formula` and `attachment` stay creatable but the
    detail page renders them read-only until their engines land. */
const FIELD_TYPE_CHOICES: { value: string; label: string }[] = [
  { value: 'short_text', label: 'Text' },
  { value: 'long_text', label: 'Long text' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'date', label: 'Date' },
  { value: 'currency', label: '$ amount' },
  { value: 'number', label: 'Number' },
  { value: 'users', label: 'People' },
  { value: 'phone', label: 'Phone number' },
  { value: 'url', label: 'Link' },
  { value: 'location', label: 'Address' },
  { value: 'attachment', label: 'Attachment' },
  { value: 'formula', label: 'Function' },
  { value: 'rating', label: 'Rating' },
];

const typeLabelOf = (v: string) =>
  FIELD_TYPE_CHOICES.find((c) => c.value === v)?.label ?? v;

export function AdminFieldsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-fields'], queryFn: listAdminFields, retry: 0 });
  const items = q.data?.items ?? [];
  const unused = items.filter((f) => f.used_by === 0).length;

  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const done = () => {
    setError(null);
    // The catalogue feeds the list page and the detail page too.
    void qc.invalidateQueries({ queryKey: ['admin-fields'] });
    void qc.invalidateQueries({ queryKey: ['wo-fields'] });
  };
  const fail = (err: unknown) =>
    setError(err instanceof ApiRequestError ? err.message : 'The change did not save');

  const update = useMutation({
    mutationFn: (v: { id: string; input: Parameters<typeof updateAdminField>[1] }) =>
      updateAdminField(v.id, v.input),
    onSuccess: () => { done(); setRenaming(null); },
    onError: fail,
  });

  const create = useMutation({
    mutationFn: createAdminField,
    onSuccess: () => { done(); setAdding(false); },
    onError: fail,
  });

  const reorderMutation = useMutation({
    mutationFn: reorderAdminFields,
    onSuccess: done,
    onError: fail,
  });

  const reorder = useReorder((from, to) => {
    if (to < 0 || to >= items.length) return;
    const ids = items.map((f) => f.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    // Optimistic: paint the new order instantly, let the PUT confirm it.
    qc.setQueryData(['admin-fields'], {
      items: ids.map((id) => items.find((f) => f.id === id)!),
    });
    reorderMutation.mutate(ids);
  });

  const busy = update.isPending || create.isPending || reorderMutation.isPending;

  return (
    <AdminShell
      title="Custom fields"
      subtitle={`The work-order record: ${items.length} fields, in the default order every user starts from${unused ? ` · ${unused} unused` : ''}`}
      actions={
        <button type="button" className="btn btn-primary" onClick={() => setAdding((v) => !v)}>
          <Icon name="plus" size={14} />
          New field
        </button>
      }
    >
      <div className="callout" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span>
          Renaming changes the <b>label</b> everywhere (lists, filters, the audit trail — old
          entries included); the mono <b>key</b> underneath is the storage address and never
          changes. Drag rows to set the default field order — each user can still arrange their
          own order on the work-order page.
        </span>
      </div>

      {error && (
        <div className="callout" style={{ marginBottom: 16 }} role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </div>
      )}

      {adding && (
        <NewFieldForm
          busy={create.isPending}
          onCancel={() => setAdding(false)}
          onSubmit={(v) => create.mutate(v)}
        />
      )}

      {q.isLoading && <AdminEmpty icon="list" title="Loading fields…" />}
      {q.isError && <AdminEmpty icon="alert" title="Could not load fields" />}

      {items.length > 0 && (
        <div className="table-wrap">
          <table className="ct fields-ct">
            <thead>
              <tr>
                <th aria-label="Reorder" />
                <th>Field</th>
                <th>Type</th>
                <th>Options</th>
                <th className="num">Used by</th>
              </tr>
            </thead>
            <tbody>
              {items.map((f, i) => (
                <FieldRow
                  key={f.id}
                  field={f}
                  index={i}
                  busy={busy}
                  renaming={renaming === f.id}
                  renameDraft={renameDraft}
                  onRenameDraft={setRenameDraft}
                  onStartRename={() => { setRenaming(f.id); setRenameDraft(f.label); }}
                  onCancelRename={() => setRenaming(null)}
                  onCommitRename={() => {
                    const label = renameDraft.trim();
                    if (label && label !== f.label) update.mutate({ id: f.id, input: { label } });
                    else setRenaming(null);
                  }}
                  onType={(type) => update.mutate({ id: f.id, input: { type } })}
                  optionsOpen={optionsFor === f.id}
                  onToggleOptions={() => setOptionsFor(optionsFor === f.id ? null : f.id)}
                  onOptions={(options) => update.mutate({ id: f.id, input: { options } })}
                  reorder={reorder}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}

function FieldRow({
  field: f, index, busy, renaming, renameDraft, onRenameDraft, onStartRename,
  onCancelRename, onCommitRename, onType, optionsOpen, onToggleOptions, onOptions, reorder,
}: {
  field: AdminFieldItem;
  index: number;
  busy: boolean;
  renaming: boolean;
  renameDraft: string;
  onRenameDraft: (v: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onCommitRename: () => void;
  onType: (type: string) => void;
  optionsOpen: boolean;
  onToggleOptions: () => void;
  onOptions: (options: string[]) => void;
  reorder: ReturnType<typeof useReorder>;
}) {
  const isDropdown = f.type === 'dropdown';
  return (
    <>
      <tr
        className={`${f.used_by === 0 ? 'is-dim ' : ''}${reorder.dragging === index ? 'is-dragging' : ''}`}
        {...reorder.rowProps(index)}
      >
        <td className="fgrip-cell">
          <button
            type="button"
            className="fgrip"
            aria-label={`Move ${f.label} (position ${index + 1})`}
            {...reorder.gripProps(index)}
          >
            <Icon name="grip" size={12} />
          </button>
        </td>
        <td>
          {renaming ? (
            <span className="frename">
              <input
                className="fld"
                value={renameDraft}
                autoFocus
                onChange={(e) => onRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCommitRename();
                  if (e.key === 'Escape') onCancelRename();
                }}
              />
              <button type="button" className="linkbtn" disabled={busy} onClick={onCommitRename}>Save</button>
              <button type="button" className="linkbtn" onClick={onCancelRename}>Cancel</button>
            </span>
          ) : (
            <div className="site">
              <strong>
                {f.label}
                <button type="button" className="fedit" title={`Rename ${f.label}`} onClick={onStartRename}>
                  <Icon name="pencil" size={12} />
                </button>
              </strong>
              <small className="mono">{f.key}</small>
            </div>
          )}
        </td>
        <td>
          <select
            className="fld fld-sm"
            value={f.type}
            disabled={busy}
            aria-label={`Type of ${f.label}`}
            onChange={(e) => onType(e.target.value)}
          >
            {FIELD_TYPE_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </td>
        <td>
          {isDropdown ? (
            <button type="button" className="linkbtn" aria-expanded={optionsOpen} onClick={onToggleOptions}>
              {f.option_count} value{f.option_count === 1 ? '' : 's'} {optionsOpen ? '▴' : '▾'}
            </button>
          ) : (
            <span className="faint">—</span>
          )}
        </td>
        <td className="num">{f.used_by || '—'}</td>
      </tr>
      {isDropdown && optionsOpen && (
        <tr className="foptions-row">
          <td />
          <td colSpan={4}>
            <OptionsEditor
              label={f.label}
              options={f.options}
              busy={busy}
              onSave={onOptions}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/** The dropdown vocabulary: remove with ×, add from the input, Save commits the
    whole list. Removing a value never touches work orders that already hold it —
    they keep it, and the editors keep it selectable. */
function OptionsEditor({ label, options, busy, onSave }: {
  label: string;
  options: string[];
  busy: boolean;
  onSave: (options: string[]) => void;
}) {
  const [draft, setDraft] = useState<string[]>(options);
  const [add, setAdd] = useState('');
  const dirty = JSON.stringify(draft) !== JSON.stringify(options);

  const addValue = () => {
    const v = add.trim();
    if (!v || draft.includes(v)) return;
    setDraft([...draft, v]);
    setAdd('');
  };

  return (
    <div className="foptions">
      <div className="foptions-chips">
        {draft.map((o) => (
          <span key={o} className="chip chip-sm foption">
            {o}
            <button
              type="button"
              aria-label={`Remove ${o} from ${label}`}
              onClick={() => setDraft(draft.filter((d) => d !== o))}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        {draft.length === 0 && <span className="faint">No values yet — add the first one below.</span>}
      </div>
      <div className="foptions-add">
        <input
          className="fld fld-sm"
          placeholder={`Add a ${label} value…`}
          value={add}
          onChange={(e) => setAdd(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addValue(); } }}
        />
        <button type="button" className="btn btn-sm" onClick={addValue} disabled={add.trim() === ''}>
          <Icon name="plus" size={12} />
          Add
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!dirty || busy}
          onClick={() => onSave(draft)}
        >
          {busy ? 'Saving…' : 'Save values'}
        </button>
        {dirty && !busy && (
          <button type="button" className="linkbtn" onClick={() => setDraft(options)}>Reset</button>
        )}
      </div>
    </div>
  );
}

function NewFieldForm({ busy, onCancel, onSubmit }: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (v: { label: string; type: string; options?: string[] }) => void;
}) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState('short_text');
  const [optionsText, setOptionsText] = useState('');
  const valid = label.trim().length > 0;

  return (
    <section className="card adm-form">
      <div className="card-head">
        <h3 className="card-title">New field</h3>
        <span className="card-meta">Appears on every work order immediately</span>
      </div>
      <div className="card-pad">
        <div className="frow">
          <div className="field">
            <label className="lbl" htmlFor="nf-label">Name <span className="req">*</span></label>
            <input className="fld" id="nf-label" type="text" placeholder="Warranty Expiry"
              value={label} onChange={(e) => setLabel(e.target.value)} />
            <span className="hint">Also becomes the field's permanent storage key.</span>
          </div>
          <div className="field">
            <label className="lbl" htmlFor="nf-type">Type</label>
            <select className="fld" id="nf-type" value={type} onChange={(e) => setType(e.target.value)}>
              {FIELD_TYPE_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
        </div>
        {type === 'dropdown' && (
          <div className="field">
            <label className="lbl" htmlFor="nf-options">Dropdown values <span className="opt">one per line</span></label>
            <textarea className="fld" id="nf-options" rows={4} placeholder={'Value A\nValue B'}
              value={optionsText} onChange={(e) => setOptionsText(e.target.value)} />
          </div>
        )}
        <div className="sheet-f">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!valid || busy}
            onClick={() => onSubmit({
              label: label.trim(),
              type,
              options: type === 'dropdown'
                ? optionsText.split('\n').map((s) => s.trim()).filter(Boolean)
                : undefined,
            })}>
            <Icon name="plus" size={14} />
            {busy ? 'Creating…' : `Create ${typeLabelOf(type).toLowerCase()} field`}
          </button>
        </div>
      </div>
    </section>
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

