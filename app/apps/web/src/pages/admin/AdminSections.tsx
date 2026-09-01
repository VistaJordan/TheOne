/* Admin Studio — Settings, Automations, Custom fields (incl. the status
   editor), Themes, Trash. All read from real data. Where a section is
   read-only it says so and says why, rather than showing controls that would
   not take effect. */

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell, AdminEmpty } from './AdminShell';
import { Icon } from '../../components/Icon';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { StatusCircle } from '../../components/StatusCircle';
import { useTheme } from '../../theme/ThemeProvider';
import { useReorder } from '../../hooks/useReorder';
import { defaultOp, isComplete, isMulti, isValueless, opLabel } from '../../lib/woView';
import {
  ApiRequestError,
  createAdminField,
  createAdminGroup,
  createAdminStatus,
  createAutomation,
  deleteAdminGroup,
  deleteAdminStatus,
  deleteAutomation,
  getAdminSettings,
  getWoFields,
  listAdminFields,
  listAdminWorkflow,
  listAutomationRuns,
  listAutomations,
  listTrash,
  reorderAdminFields,
  restoreFromTrash,
  updateAdminField,
  updateAdminGroup,
  updateAdminStatus,
  updateAutomation,
  type AdminFieldItem,
  type AdminWorkflowItem,
  type AutomationEntity,
  type AutomationInput,
  type AutomationItem,
  type AutomationTriggerKind,
  type StatusGroupItem,
  type WoFieldDescriptor,
  type WoFilterOp,
  type WoFilterRule,
  type WoFieldType,
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

// ══ STATUS EDITOR — the status engine (rename / add / delete, plus phases) ═══
// Lived on its own "Workflows" tab until Automations took that slot; now
// embedded at the bottom of Custom fields — statuses are vocabulary, like
// fields, and Automations is where behaviour lives.

/** The two statuses the dashboard KPI tiles still match by NAME (kpis.ts). */
const KPI_STATUS_NAMES = ['Waiting for Approval', 'Ready to Invoice'];

function StatusEditor() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-workflow'], queryFn: listAdminWorkflow, retry: 0 });
  const items = q.data?.items ?? [];
  const groups = q.data?.groups ?? [];

  const [error, setError] = useState<string | null>(null);
  const [addingPhase, setAddingPhase] = useState(false);
  const [confirm, setConfirm] = useState<
    | { kind: 'status'; id: string; name: string }
    | { kind: 'group'; code: string; label: string }
    | null
  >(null);

  const done = () => {
    setError(null);
    // Every surface that renders statuses re-reads: this page, the change-status
    // menus, the list tabs, the filter catalogue, the pills, the KPI tiles.
    for (const key of ['admin-workflow', 'statuses', 'status-groups', 'wo-fields', 'work-orders', 'kpis']) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };
  const fail = (err: unknown) =>
    setError(err instanceof ApiRequestError ? err.message : 'The change did not save');

  const patchStatusM = useMutation({
    mutationFn: (v: { id: string; input: { name?: string; color?: string } }) =>
      updateAdminStatus(v.id, v.input),
    onSuccess: done,
    onError: fail,
  });
  const createStatusM = useMutation({
    mutationFn: (v: { name: string; group: string; color: string }) => createAdminStatus(v),
    onSuccess: done,
    onError: fail,
  });
  const deleteStatusM = useMutation({
    mutationFn: (id: string) => deleteAdminStatus(id),
    onSuccess: done,
    onError: fail,
    onSettled: () => setConfirm(null),
  });
  const createGroupM = useMutation({
    mutationFn: (label: string) => createAdminGroup(label),
    onSuccess: () => { done(); setAddingPhase(false); },
    onError: fail,
  });
  const renameGroupM = useMutation({
    mutationFn: (v: { code: string; label: string }) => updateAdminGroup(v.code, v.label),
    onSuccess: done,
    onError: fail,
  });
  const deleteGroupM = useMutation({
    mutationFn: (code: string) => deleteAdminGroup(code),
    onSuccess: done,
    onError: fail,
    onSettled: () => setConfirm(null),
  });

  const busy =
    patchStatusM.isPending || createStatusM.isPending || deleteStatusM.isPending ||
    createGroupM.isPending || renameGroupM.isPending || deleteGroupM.isPending;

  return (
    <>
      <div className="adm-subsec">
        <div className="adm-subsec-text">
          <h3 className="adm-subsec-title">Statuses</h3>
          <p className="adm-sub">
            The {items.length}-status pipeline every work order moves through, in order — rename,
            recolor, add or retire statuses per phase. Changes apply everywhere immediately
            (menus, tabs, filters, pills). Two dashboard tiles still match statuses by name
            (<i>Waiting for Approval</i>, <i>Ready to Invoice</i>), so renaming those empties
            their tiles.
          </p>
        </div>
        <button type="button" className="btn" onClick={() => setAddingPhase((v) => !v)}>
          <Icon name="plus" size={14} />
          New phase
        </button>
      </div>

      {error && (
        <div className="callout" style={{ marginBottom: 16 }} role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </div>
      )}

      {addingPhase && (
        <NewPhaseForm
          busy={createGroupM.isPending}
          onCancel={() => setAddingPhase(false)}
          onSubmit={(label) => createGroupM.mutate(label)}
        />
      )}

      {q.isLoading && <AdminEmpty icon="swap" title="Loading pipeline…" />}
      {q.isError && <AdminEmpty icon="alert" title="Could not load the pipeline" />}

      {groups.map((g) => (
        <WfGroupCard
          key={g.code}
          group={g}
          rows={items.filter((s) => s.status_group === g.code)}
          busy={busy}
          onRenameGroup={(label) => renameGroupM.mutate({ code: g.code, label })}
          onDeleteGroup={() => setConfirm({ kind: 'group', code: g.code, label: g.label })}
          onRenameStatus={(id, name) => patchStatusM.mutate({ id, input: { name } })}
          onRecolorStatus={(id, color) => patchStatusM.mutate({ id, input: { color } })}
          onDeleteStatus={(id, name) => setConfirm({ kind: 'status', id, name })}
          onAddStatus={(name, color) => createStatusM.mutate({ name, group: g.code, color })}
        />
      ))}

      {confirm?.kind === 'status' && (
        <ConfirmDialog
          title={`Delete the “${confirm.name}” status?`}
          message="It disappears from every status menu. Work orders are unaffected — a status can only be deleted while none sit at it."
          confirmLabel="Delete status"
          busyLabel="Deleting…"
          danger
          busy={deleteStatusM.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => deleteStatusM.mutate(confirm.id)}
        />
      )}
      {confirm?.kind === 'group' && (
        <ConfirmDialog
          title={`Delete the “${confirm.label}” phase?`}
          message="Only an empty phase can be deleted; the built-in four cannot."
          confirmLabel="Delete phase"
          busyLabel="Deleting…"
          danger
          busy={deleteGroupM.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => deleteGroupM.mutate(confirm.code)}
        />
      )}
    </>
  );
}

// ══ AUTOMATIONS — the rules engine (When → If → Then) ════════════════════════
// The builder writes the same vocabulary the server validates: triggers and
// actions name catalogue fields, conditions are the list's own FilterSet.

/** Fields that never fire a trigger: derived or write-once bookkeeping. */
const UNTRIGGERABLE = new Set(['age_days', 'created_at', 'updated_at', 'wo_number', 'status_group']);

/** Custom-field subtypes an action cannot write (same rule as the inline editor). */
const UNSETTABLE_SUBTYPES = new Set(['formula', 'attachment']);

function fieldLabel(key: string, fields: WoFieldDescriptor[]): string {
  return fields.find((f) => f.key === key)?.label ?? key.replace(/^fields\./, '');
}

/** "10 min" / "2 hours" / "3 days" — the largest unit that divides cleanly. */
function fmtDelay(minutes: number): string {
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${minutes} min`;
}

/** The card's one-line reading of a rule: when — if — then. */
function summarize(a: AutomationItem, fields: WoFieldDescriptor[]): string {
  const t = a.trigger;
  const base =
    t.kind === 'manual'
      ? 'When work orders are enrolled from the list'
      : t.kind === 'created'
        ? 'When a work order is created'
        : t.field
          ? `When ${fieldLabel(t.field, fields)} changes${t.to ? ` to “${t.to}”` : ''}`
          : 'When any field changes';
  const when = t.delay_minutes ? `${base} — wait ${fmtDelay(t.delay_minutes)}` : base;
  const n = a.conditions?.rules?.length ?? 0;
  const iff = n > 0 ? ` — if ${n === 1 ? '1 condition matches' : `${n} conditions match`}` : '';
  const then = a.actions
    .map((x) =>
      x.value === null || x.value === ''
        ? `clear ${fieldLabel(x.field, fields)}`
        : `set ${fieldLabel(x.field, fields)} to “${x.value}”`,
    )
    .join(', ');
  return then ? `${when}${iff} — ${then}` : `${when}${iff}`;
}

export function AdminAutomationsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-automations'], queryFn: listAutomations, retry: 0 });
  const catQ = useQuery({ queryKey: ['wo-fields'], queryFn: getWoFields, retry: 0 });
  const items = q.data?.items ?? [];
  const fields = catQ.data?.fields ?? [];
  const opsByType = catQ.data?.ops_by_type;

  const [editing, setEditing] = useState<AutomationItem | 'new' | null>(null);
  const [confirm, setConfirm] = useState<AutomationItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const done = () => {
    setError(null);
    void qc.invalidateQueries({ queryKey: ['admin-automations'] });
  };
  const fail = (err: unknown) =>
    setError(err instanceof ApiRequestError ? err.message : 'The change did not save');

  const createM = useMutation({
    mutationFn: createAutomation,
    onSuccess: () => { done(); setEditing(null); },
    onError: fail,
  });
  const updateM = useMutation({
    mutationFn: (v: { id: string; input: Partial<AutomationInput> }) =>
      updateAutomation(v.id, v.input),
    onSuccess: () => { done(); setEditing(null); },
    onError: fail,
  });
  const toggleM = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      updateAutomation(v.id, { enabled: v.enabled }),
    onSuccess: done,
    onError: fail,
  });
  const deleteM = useMutation({
    mutationFn: (id: string) => deleteAutomation(id),
    onSuccess: done,
    onError: fail,
    onSettled: () => setConfirm(null),
  });

  const busy = createM.isPending || updateM.isPending;

  return (
    <AdminShell
      title="Automations"
      actions={
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setEditing(editing === 'new' ? null : 'new')}
        >
          <Icon name="plus" size={14} />
          New automation
        </button>
      }
    >
      {error && (
        <div className="callout" style={{ marginBottom: 16 }} role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </div>
      )}

      {editing && (
        <AutomationBuilder
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          fields={fields}
          opsByType={opsByType}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(input) => {
            if (editing === 'new') createM.mutate(input);
            else updateM.mutate({ id: editing.id, input });
          }}
        />
      )}

      {q.isLoading && <AdminEmpty icon="zap" title="Loading automations…" />}
      {q.isError && <AdminEmpty icon="alert" title="Could not load automations" />}

      {!q.isLoading && !q.isError && items.length === 0 && !editing && (
        <AdminEmpty icon="zap" title="No automations yet" />
      )}

      <div className="auto-list">
        {items.map((a) => (
          <AutomationCard
            key={a.id}
            a={a}
            fields={fields}
            busy={toggleM.isPending}
            onToggle={(enabled) => toggleM.mutate({ id: a.id, enabled })}
            onEdit={() => setEditing(a)}
            onDelete={() => setConfirm(a)}
          />
        ))}
      </div>

      {confirm && (
        <ConfirmDialog
          title={`Delete the “${confirm.name}” automation?`}
          message="The rule stops firing immediately and its run history is deleted with it. Changes it already made to work orders stay."
          confirmLabel="Delete automation"
          busyLabel="Deleting…"
          danger
          busy={deleteM.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => deleteM.mutate(confirm.id)}
        />
      )}
    </AdminShell>
  );
}

function AutomationCard({ a, fields, busy, onToggle, onEdit, onDelete }: {
  a: AutomationItem;
  fields: WoFieldDescriptor[];
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [showRuns, setShowRuns] = useState(false);

  return (
    <section className={`card auto-card${a.enabled ? '' : ' is-off'}`}>
      <div className="card-head">
        <label className="sw" title={a.enabled ? 'On — click to pause' : 'Paused — click to enable'}>
          <input
            type="checkbox"
            checked={a.enabled}
            disabled={busy}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={`${a.name} is ${a.enabled ? 'on' : 'paused'}`}
          />
          <span className="sw-track" aria-hidden="true" />
        </label>
        <div className="auto-title">
          <strong>
            {a.name}
            {a.trigger.kind === 'manual' && <span className="chip chip-sm auto-chip">Manual</span>}
          </strong>
          <small>{summarize(a, fields)}</small>
        </div>
        <button
          type="button"
          className="linkbtn push"
          aria-expanded={showRuns}
          onClick={() => setShowRuns((v) => !v)}
        >
          {a.run_count} run{a.run_count === 1 ? '' : 's'} {showRuns ? '▴' : '▾'}
        </button>
        <button type="button" className="fedit" title={`Edit ${a.name}`} onClick={onEdit}>
          <Icon name="pencil" size={12} />
        </button>
        <button type="button" className="wf-x" title={`Delete ${a.name}`} onClick={onDelete}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      {showRuns && <RunLog id={a.id} fields={fields} />}
    </section>
  );
}

function RunLog({ id, fields }: { id: string; fields: WoFieldDescriptor[] }) {
  const q = useQuery({
    queryKey: ['automation-runs', id],
    queryFn: () => listAutomationRuns(id),
    retry: 0,
  });
  const items = q.data?.items ?? [];

  const describe = (r: (typeof items)[number]): string => {
    const d = (r.detail ?? {}) as {
      applied?: { field: string; value: string | null }[];
      message?: string;
    };
    if (r.outcome === 'error') return d.message ?? 'Failed';
    if (r.outcome === 'skipped') return d.message ?? 'Skipped — conditions no longer matched';
    return (d.applied ?? [])
      .map((x) =>
        x.value === null
          ? `cleared ${fieldLabel(x.field, fields)}`
          : `${fieldLabel(x.field, fields)} → ${x.value}`,
      )
      .join(' · ') || 'Applied';
  };

  return (
    <div className="auto-runs">
      {q.isLoading && <span className="faint">Loading runs…</span>}
      {q.isError && <span className="faint">Could not load the run log.</span>}
      {!q.isLoading && !q.isError && items.length === 0 && (
        <span className="faint">This automation has not run yet.</span>
      )}
      {items.length > 0 && (
        <div className="table-wrap">
          <table className="ct">
            <thead>
              <tr><th>When</th><th>Work order</th><th>Result</th></tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td className="faint">{new Date(r.created_at).toLocaleString()}</td>
                  <td><span className="wo-num">{r.wo_number ?? '—'}</span></td>
                  <td className={
                    r.outcome === 'error' ? 'auto-run-err'
                      : r.outcome === 'skipped' ? 'faint'
                        : undefined
                  }>
                    {describe(r)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── The builder: a step-by-step wizard (HubSpot-style) ───────────────────────
// Trigger → Applies to → Conditions → Actions. Completed steps are clickable
// in the stepper.

interface RuleDraft { field: string; op: WoFilterOp; value: string }
interface ActionDraft { field: string; value: string }

type DelayUnit = 'minutes' | 'hours' | 'days';
const DELAY_UNIT_MINUTES: Record<DelayUnit, number> = { minutes: 1, hours: 60, days: 1440 };

const BUILDER_STEPS = ['Trigger', 'Applies to', 'Conditions', 'Actions'] as const;

function AutomationBuilder({ initial, fields, opsByType, busy, onCancel, onSave }: {
  initial: AutomationItem | null;
  fields: WoFieldDescriptor[];
  opsByType?: Record<WoFieldType, WoFilterOp[]>;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: AutomationInput) => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState(initial?.name ?? '');
  const [entity, setEntity] = useState<AutomationEntity>(initial?.entity ?? 'work_order');
  const [kind, setKind] = useState<AutomationTriggerKind>(initial?.trigger.kind ?? 'changed');
  const [trigField, setTrigField] = useState(initial?.trigger.field ?? '');
  const [trigTo, setTrigTo] = useState(initial?.trigger.to ?? '');
  // The wait, split into amount + unit for editing; stored as whole minutes.
  const initDelay = initial?.trigger.delay_minutes ?? 0;
  const initUnit: DelayUnit =
    initDelay > 0 && initDelay % 1440 === 0 ? 'days'
      : initDelay > 0 && initDelay % 60 === 0 ? 'hours'
        : 'minutes';
  const [delayAmount, setDelayAmount] = useState(
    initDelay > 0 ? String(initDelay / DELAY_UNIT_MINUTES[initUnit]) : '',
  );
  const [delayUnit, setDelayUnit] = useState<DelayUnit>(initUnit);
  const [match, setMatch] = useState<'all' | 'any'>(initial?.conditions?.match ?? 'all');
  const [rules, setRules] = useState<RuleDraft[]>(
    (initial?.conditions?.rules ?? []).map((r) => ({
      field: r.field,
      op: r.op,
      value: Array.isArray(r.value) ? r.value.join(', ') : String(r.value ?? ''),
    })),
  );
  const [actions, setActions] = useState<ActionDraft[]>(
    initial
      ? initial.actions.map((x) => ({ field: x.field, value: x.value ?? '' }))
      : [{ field: 'status', value: '' }],
  );

  const triggerFields = fields.filter((f) => !UNTRIGGERABLE.has(f.key));
  const actionFields = fields.filter(
    (f) =>
      f.key === 'status' ||
      f.key === 'priority' ||
      (f.custom && !UNSETTABLE_SUBTYPES.has(f.subtype ?? '')),
  );
  const byKey = (key: string) => fields.find((f) => f.key === key);

  const setRule = (i: number, patch: Partial<RuleDraft>) =>
    setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setAction = (i: number, patch: Partial<ActionDraft>) =>
    setActions(actions.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  const delayMinutes = (() => {
    const n = Number(delayAmount);
    return delayAmount.trim() !== '' && Number.isFinite(n) && n > 0
      ? Math.round(n * DELAY_UNIT_MINUTES[delayUnit])
      : 0;
  })();

  const build = (): AutomationInput => ({
    name: name.trim(),
    entity,
    trigger: {
      kind,
      field: kind === 'changed' && trigField ? trigField : null,
      to: kind === 'changed' && trigField && trigTo.trim() ? trigTo.trim() : null,
      delay_minutes: delayMinutes > 0 ? delayMinutes : null,
    },
    conditions: {
      match,
      rules: rules
        .filter((r) => r.field)
        .map((r): WoFilterRule => {
          if (isValueless(r.op)) return { field: r.field, op: r.op };
          if (isMulti(r.op) || r.op === 'between') {
            return {
              field: r.field,
              op: r.op,
              value: r.value.split(',').map((s) => s.trim()).filter(Boolean),
            };
          }
          return { field: r.field, op: r.op, value: r.value };
        })
        .filter(isComplete),
    },
    actions: actions
      .filter((a) => a.field)
      .map((a) => ({ field: a.field, value: a.value.trim() === '' ? null : a.value })),
  });

  const actionsValid =
    actions.some((a) => a.field) &&
    // A status action with no target status is half-written, not a "clear".
    actions.every((a) => a.field !== 'status' || a.value.trim() !== '');
  const valid = name.trim().length > 0 && actionsValid;

  const last = step === BUILDER_STEPS.length - 1;

  return (
    <section className="card adm-form auto-builder">
      <div className="card-head">
        <h3 className="card-title">{initial ? `Edit “${initial.name}”` : 'New automation'}</h3>
        <span className="card-meta">Step {step + 1} of {BUILDER_STEPS.length} — {BUILDER_STEPS[step]}</span>
      </div>
      <div className="card-pad">
        <div className="field">
          <label className="lbl" htmlFor="au-name">Name <span className="req">*</span></label>
          <input
            className="fld" id="au-name" type="text"
            placeholder="Rush new quote approvals"
            value={name} onChange={(e) => setName(e.target.value)}
          />
        </div>

        <ol className="auto-stepper">
          {BUILDER_STEPS.map((label, i) => (
            <li key={label} className={i === step ? 'is-current' : i < step ? 'is-done' : ''}>
              {/* Completed steps reopen on click; future ones wait their turn. */}
              <button type="button" disabled={i > step} onClick={() => setStep(i)}>
                <span className="auto-step-dot">{i < step ? <Icon name="check" size={12} /> : i + 1}</span>
                {label}
              </button>
            </li>
          ))}
        </ol>
        {step === 0 && (
          <>
            <div className="auto-tiles">
              <TileBtn
                icon="zap" label="A work order is created"
                hint="Fires the moment a new record lands — created in the app or by CSV import"
                active={kind === 'created'} onClick={() => setKind('created')}
              />
              <TileBtn
                icon="swap" label="A field changes"
                hint="Any field, or one specific field — optionally only when it changes to a specific value"
                active={kind === 'changed'} onClick={() => setKind('changed')}
              />
              <TileBtn
                icon="user" label="Manually enrolled"
                hint="Never fires on its own — select work orders in the list and press Enroll"
                active={kind === 'manual'} onClick={() => setKind('manual')}
              />
            </div>

            {kind === 'changed' && (
              <div className="auto-row auto-row-when">
                <FieldSelect
                  fields={triggerFields}
                  value={trigField}
                  anyLabel="Any field"
                  ariaLabel="Which field"
                  onChange={(v) => { setTrigField(v); setTrigTo(''); }}
                />
                {trigField && (
                  <ValueControl
                    desc={byKey(trigField)}
                    value={trigTo}
                    emptyLabel="to any value"
                    placeholder="to any value"
                    onChange={setTrigTo}
                  />
                )}
              </div>
            )}

            <div className="auto-wait">
              <span className="auto-wait-label">then wait</span>
              <input
                className="fld fld-sm auto-wait-n" type="number" min={0} step={1}
                value={delayAmount} placeholder="0"
                aria-label="How long to wait before acting"
                onChange={(e) => setDelayAmount(e.target.value)}
              />
              <select
                className="fld fld-sm" value={delayUnit} aria-label="Wait unit"
                onChange={(e) => setDelayUnit(e.target.value as DelayUnit)}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
              <span className="faint">
                {delayMinutes > 0
                  ? 'before acting — conditions are checked when the wait ends, and another matching change restarts the clock'
                  : 'leave at 0 to act immediately'}
              </span>
            </div>
          </>
        )}

        {step === 1 && (
          <div className="auto-tiles">
            <TileBtn
              icon="clipboard" label="Work orders"
              hint="The live record type — statuses, priority and every custom field"
              active={entity === 'work_order'} onClick={() => setEntity('work_order')}
            />
            <TileBtn icon="truck" label="Vendors" hint="Arrives with the Vendors module" disabled />
            <TileBtn icon="file" label="Quotes" hint="Arrives when quote automations go live" disabled />
            <TileBtn icon="dollar" label="Invoices" hint="Arrives with the Invoicing module" disabled />
          </div>
        )}

        {step === 2 && (
        <div className="auto-step">
          <span className="auto-kicker">
            If
            {rules.length > 1 && (
              <select
                className="fld fld-sm auto-match" value={match} aria-label="Match"
                onChange={(e) => setMatch(e.target.value as 'all' | 'any')}
              >
                <option value="all">all conditions match</option>
                <option value="any">any condition matches</option>
              </select>
            )}
          </span>
          {rules.map((r, i) => {
            const f = byKey(r.field);
            const allowed = f && opsByType ? opsByType[f.type] : [];
            return (
              <div className="auto-row" key={i}>
                <FieldSelect
                  fields={fields}
                  value={r.field}
                  anyLabel="Pick a field…"
                  ariaLabel={`Condition ${i + 1} field`}
                  onChange={(v) => {
                    const nf = byKey(v);
                    setRule(i, {
                      field: v,
                      op: nf && opsByType ? defaultOp(nf.type, opsByType[nf.type]) : 'eq',
                      value: '',
                    });
                  }}
                />
                {f && (
                  <select
                    className="fld fld-sm" value={r.op} aria-label={`Condition ${i + 1} test`}
                    onChange={(e) => setRule(i, { op: e.target.value as WoFilterOp, value: '' })}
                  >
                    {allowed.map((op) => (
                      <option key={op} value={op}>{opLabel(op, f.type)}</option>
                    ))}
                  </select>
                )}
                {f && !isValueless(r.op) && (
                  isMulti(r.op) || r.op === 'between' ? (
                    <input
                      className="fld fld-sm"
                      value={r.value}
                      placeholder={r.op === 'between' ? 'low, high' : 'value, value, …'}
                      aria-label={`Condition ${i + 1} values`}
                      onChange={(e) => setRule(i, { value: e.target.value })}
                    />
                  ) : (
                    <ValueControl
                      desc={f}
                      value={r.value}
                      placeholder="value"
                      ariaLabel={`Condition ${i + 1} value`}
                      onChange={(v) => setRule(i, { value: v })}
                    />
                  )
                )}
                <button
                  type="button" className="wf-x" title="Remove this condition"
                  onClick={() => setRules(rules.filter((_, j) => j !== i))}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            );
          })}
          <button
            type="button" className="linkbtn auto-add"
            onClick={() => setRules([...rules, { field: '', op: 'eq', value: '' }])}
          >
            + Add a condition{rules.length === 0 ? ' (optional — no conditions means always)' : ''}
          </button>
        </div>
        )}

        {step === 3 && (
        <div className="auto-step">
          <span className="auto-kicker">Then</span>
          {actions.map((a, i) => {
            const f = byKey(a.field);
            return (
              <div className="auto-row auto-row-then" key={i}>
                <FieldSelect
                  fields={actionFields}
                  value={a.field}
                  anyLabel="Pick a field to set…"
                  ariaLabel={`Action ${i + 1} field`}
                  onChange={(v) => setAction(i, { field: v, value: '' })}
                />
                {a.field && (
                  <ValueControl
                    desc={f}
                    value={a.value}
                    emptyLabel={a.field === 'status' ? 'pick a status…' : '— clear the field —'}
                    placeholder="new value (empty clears)"
                    ariaLabel={`Action ${i + 1} value`}
                    onChange={(v) => setAction(i, { value: v })}
                  />
                )}
                <button
                  type="button" className="wf-x" title="Remove this action"
                  disabled={actions.length === 1}
                  onClick={() => setActions(actions.filter((_, j) => j !== i))}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            );
          })}
          <button
            type="button" className="linkbtn auto-add"
            onClick={() => setActions([...actions, { field: '', value: '' }])}
          >
            + Add an action
          </button>
        </div>
        )}

        <div className="sheet-f">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          {step > 0 && (
            <button type="button" className="btn" onClick={() => setStep(step - 1)}>
              <Icon name="arrow-l" size={14} />
              Back
            </button>
          )}
          {!last ? (
            <button type="button" className="btn btn-primary" onClick={() => setStep(step + 1)}>
              Next
              <Icon name="arrow-r" size={14} />
            </button>
          ) : (
            <button
              type="button" className="btn btn-primary" disabled={!valid || busy}
              title={!valid && actionsValid ? 'Give the automation a name first' : undefined}
              onClick={() => onSave(build())}
            >
              <Icon name="check" size={14} />
              {busy ? 'Saving…' : initial ? 'Save changes' : 'Review and turn on'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** One choice tile — the HubSpot-style big radio button. */
function TileBtn({ icon, label, hint, active, disabled, onClick }: {
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  hint: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`auto-tile${active ? ' is-active' : ''}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="auto-tile-head">
        <Icon name={icon} size={16} />
        <b>{label}</b>
        {disabled && <span className="chip chip-sm">Soon</span>}
      </span>
      <small>{hint}</small>
    </button>
  );
}

/** Grouped field picker (optgroups mirror the list's filter builder). */
/** Short type word shown beside each row so two same-named fields are telling apart. */
const FIELD_TYPE_WORD: Record<WoFieldType, string> = {
  text: 'text', number: 'number', money: 'money', date: 'date',
  datetime: 'date + time', select: 'choice', boolean: 'yes / no',
};

/** The empty choice, carried through the same list as the fields so the
    keyboard can reach it. */
const ANY_KEY = '';

/** A searchable field picker. The native <select> it replaces opened a list as
    tall as the screen with no way to filter; this one filters as you type,
    moves with ↑/↓ and closes on Escape. */
function FieldSelect({ fields, value, anyLabel, ariaLabel, onChange }: {
  fields: WoFieldDescriptor[];
  value: string;
  anyLabel: string;
  ariaLabel: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = fields.find((f) => f.key === value);
  const q = search.trim().toLowerCase();
  const matches = fields.filter(
    (f) => !q || f.label.toLowerCase().includes(q) || f.group.toLowerCase().includes(q),
  );
  // Searching means you want a field, so the "any" row drops out of a filtered list.
  const rows: (WoFieldDescriptor | null)[] = q ? matches : [null, ...matches];

  useEffect(() => {
    if (open) return;
    setSearch('');
    setActive(0);
  }, [open]);

  // Open on the current choice so ↑/↓ start from where the value already is.
  useEffect(() => {
    if (!open) return;
    const i = rows.findIndex((r) => (r ? r.key : ANY_KEY) === value);
    setActive(i < 0 ? 0 : i);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the panel opens
  }, [open]);

  useEffect(() => setActive(0), [search]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the highlighted row in view while the arrows walk past the fold.
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (k: string) => {
    onChange(k);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'Tab') { setOpen(false); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => Math.min(rows.length - 1, Math.max(0, i + step)));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      const row = rows[active];
      if (row || !q) choose(row ? row.key : ANY_KEY);
    }
  };

  let lastGroup: string | null = null;

  return (
    <div className="fpick" ref={rootRef}>
      <button
        type="button"
        className={`fld fld-sm fpick-btn${open ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKey}
      >
        <span className={`fpick-val${selected ? '' : ' is-empty'}`}>
          {selected ? selected.label : anyLabel}
        </span>
        {selected && <span className="fpick-btn-group">{selected.group}</span>}
        <Icon name="chev-d" size={12} />
      </button>

      {open && (
        <div className="fpick-pop" role="dialog" aria-label={ariaLabel}>
          <div className="fpick-search">
            <Icon name="search" size={14} />
            <input
              type="text"
              autoFocus
              value={search}
              placeholder="Search fields…"
              aria-label={`Search fields — ${ariaLabel}`}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={onKey}
            />
          </div>

          {/* data-oknob-own: no app-wide scrollbar rail inside a popover. */}
          <div className="fpick-list" role="listbox" ref={listRef} data-oknob-own="">
            {rows.length === 0 && (
              <p className="fpick-none">No field matches “{search.trim()}”</p>
            )}
            {rows.map((f, i) => {
              const head = f && f.group !== lastGroup ? f.group : null;
              if (f) lastGroup = f.group;
              const key = f ? f.key : ANY_KEY;
              const current = key === value;
              return (
                <div key={f ? f.key : '__any'}>
                  {head && <div className="fpick-group">{head}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={current}
                    data-i={i}
                    className={`fpick-item${i === active ? ' is-active' : ''}${current ? ' is-current' : ''}${f ? '' : ' fpick-any'}`}
                    onMouseMove={() => setActive(i)}
                    onClick={() => choose(key)}
                  >
                    <span className="fpick-item-label">{f ? f.label : anyLabel}</span>
                    {f && <span className="fpick-type">{FIELD_TYPE_WORD[f.type]}</span>}
                    {current && <Icon name="check" size={12} />}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** A value editor that matches the field's shape: its options as a menu, a
    checkbox's two states, a real date input — free text otherwise. */
function ValueControl({ desc, value, onChange, emptyLabel, placeholder, ariaLabel }: {
  desc?: WoFieldDescriptor;
  value: string;
  onChange: (v: string) => void;
  /** When present, an '' choice with this label leads the menu. */
  emptyLabel?: string;
  placeholder?: string;
  ariaLabel?: string;
}) {
  if (desc?.type === 'boolean') {
    return (
      <select
        className="fld fld-sm" value={value} aria-label={ariaLabel ?? desc.label}
        onChange={(e) => onChange(e.target.value)}
      >
        {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
        <option value="true">Checked</option>
        <option value="false">Unchecked</option>
      </select>
    );
  }
  if (desc?.type === 'select' && (desc.options?.length ?? 0) > 0) {
    return (
      <select
        className="fld fld-sm" value={value} aria-label={ariaLabel ?? desc.label}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{emptyLabel ?? 'pick a value…'}</option>
        {desc.options!.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  }
  const inputType =
    desc?.type === 'number' || desc?.type === 'money'
      ? 'number'
      : desc?.type === 'date'
        ? 'date'
        : desc?.type === 'datetime'
          ? 'datetime-local'
          : 'text';
  return (
    <input
      className="fld fld-sm" type={inputType} value={value}
      placeholder={placeholder} aria-label={ariaLabel ?? desc?.label ?? 'value'}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function WfGroupCard({
  group: g, rows, busy, onRenameGroup, onDeleteGroup,
  onRenameStatus, onRecolorStatus, onDeleteStatus, onAddStatus,
}: {
  group: StatusGroupItem;
  rows: AdminWorkflowItem[];
  busy: boolean;
  onRenameGroup: (label: string) => void;
  onDeleteGroup: () => void;
  onRenameStatus: (id: string, name: string) => void;
  onRecolorStatus: (id: string, color: string) => void;
  onDeleteStatus: (id: string, name: string) => void;
  onAddStatus: (name: string, color: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(g.label);
  const total = rows.reduce((n, r) => n + r.wo_count, 0);
  const badgeClass = ['open', 'active', 'done', 'closed'].includes(g.code) ? ` is-${g.code}` : '';

  const commitLabel = () => {
    const label = draft.trim();
    if (label && label !== g.label) onRenameGroup(label);
    setRenaming(false);
  };

  return (
    <section className="card wf-group">
      <div className="card-head">
        {renaming ? (
          <span className="frename">
            <input
              className="fld fld-sm"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitLabel();
                if (e.key === 'Escape') setRenaming(false);
              }}
            />
            <button type="button" className="linkbtn" disabled={busy} onClick={commitLabel}>Save</button>
            <button type="button" className="linkbtn" onClick={() => setRenaming(false)}>Cancel</button>
          </span>
        ) : (
          <>
            <span className={`sec-badge${badgeClass}`}>{g.label}</span>
            <button
              type="button"
              className="fedit wf-headedit"
              title={`Rename the ${g.label} phase`}
              onClick={() => { setDraft(g.label); setRenaming(true); }}
            >
              <Icon name="pencil" size={12} />
            </button>
          </>
        )}
        <span className="sec-sub">{rows.length} status{rows.length === 1 ? '' : 'es'}</span>
        <span className="subtotal-chip push">{total} work order{total === 1 ? '' : 's'}</span>
        {!g.is_builtin && rows.length === 0 && (
          <button
            type="button"
            className="wf-x"
            title={`Delete the ${g.label} phase`}
            disabled={busy}
            onClick={onDeleteGroup}
          >
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>
      <ul className="wf-list">
        {rows.map((s, i) => (
          <WfStatusRow
            key={s.id}
            status={s}
            group={g.code}
            fraction={(i + 1) / (rows.length + 1)}
            busy={busy}
            onRename={(name) => onRenameStatus(s.id, name)}
            onRecolor={(color) => onRecolorStatus(s.id, color)}
            onDelete={() => onDeleteStatus(s.id, s.name)}
          />
        ))}
      </ul>
      <AddStatusRow groupLabel={g.label} busy={busy} onAdd={onAddStatus} />
    </section>
  );
}

function WfStatusRow({ status: s, group, fraction, busy, onRename, onRecolor, onDelete }: {
  status: AdminWorkflowItem;
  group: string;
  fraction: number;
  busy: boolean;
  onRename: (name: string) => void;
  onRecolor: (color: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(s.name);
  const kpiCoupled = KPI_STATUS_NAMES.includes(s.name);

  const commit = () => {
    const name = draft.trim();
    if (name && name !== s.name) onRename(name);
    setRenaming(false);
  };

  return (
    <li className="wf-row">
      <span className="wf-pos">{s.position}</span>
      <StatusCircle group={group} color={s.color} fraction={fraction} size={16} />
      {renaming ? (
        <span className="frename">
          <input
            className="fld fld-sm"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
          <button type="button" className="linkbtn" disabled={busy} onClick={commit}>Save</button>
          <button type="button" className="linkbtn" onClick={() => setRenaming(false)}>Cancel</button>
        </span>
      ) : (
        <span className="wf-name">
          {s.name}
          <button
            type="button"
            className="fedit"
            title={
              kpiCoupled
                ? `Rename ${s.name} — careful: a dashboard tile matches this exact name`
                : `Rename ${s.name}`
            }
            onClick={() => { setDraft(s.name); setRenaming(true); }}
          >
            <Icon name="pencil" size={12} />
          </button>
        </span>
      )}
      {s.is_archive && <span className="chip chip-sm">Archive</span>}
      {/* Keyed on the saved color so an outside refresh resets the swatch. */}
      <input
        key={`${s.id}-${s.color}`}
        type="color"
        className="wf-color"
        defaultValue={s.color}
        disabled={busy}
        aria-label={`Color of ${s.name}`}
        onBlur={(e) => {
          const v = e.target.value;
          if (v && v.toLowerCase() !== s.color.toLowerCase()) onRecolor(v);
        }}
      />
      <span className="wf-count">{s.wo_count || '—'}</span>
      <button
        type="button"
        className="wf-x"
        disabled={busy || s.wo_count > 0}
        title={
          s.wo_count > 0
            ? `${s.wo_count} work order${s.wo_count === 1 ? ' is' : 's are'} at this status — move them first`
            : `Delete ${s.name}`
        }
        onClick={onDelete}
      >
        <Icon name="trash" size={14} />
      </button>
    </li>
  );
}

function AddStatusRow({ groupLabel, busy, onAdd }: {
  groupLabel: string;
  busy: boolean;
  onAdd: (name: string, color: string) => void;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#656f7d');

  const submit = () => {
    const v = name.trim();
    if (!v) return;
    onAdd(v, color);
    setName('');
  };

  return (
    <div className="wf-add">
      <input
        type="color"
        className="wf-color"
        value={color}
        aria-label={`Color of the new ${groupLabel} status`}
        onChange={(e) => setColor(e.target.value)}
      />
      <input
        className="fld fld-sm"
        placeholder={`Add a status to ${groupLabel}…`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
      />
      <button type="button" className="btn btn-sm" disabled={busy || name.trim() === ''} onClick={submit}>
        <Icon name="plus" size={12} />
        Add
      </button>
    </div>
  );
}

function NewPhaseForm({ busy, onCancel, onSubmit }: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (label: string) => void;
}) {
  const [label, setLabel] = useState('');
  const valid = label.trim().length > 0;

  return (
    <section className="card adm-form">
      <div className="card-head">
        <h3 className="card-title">New phase</h3>
        <span className="card-meta">A new group of statuses — it becomes a tab on the work-orders list</span>
      </div>
      <div className="card-pad">
        <div className="field">
          <label className="lbl" htmlFor="np-label">Name <span className="req">*</span></label>
          <input className="fld" id="np-label" type="text" placeholder="On hold"
            value={label} onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && valid) onSubmit(label.trim()); }} />
        </div>
        <div className="sheet-f">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!valid || busy}
            onClick={() => onSubmit(label.trim())}>
            <Icon name="plus" size={14} />
            {busy ? 'Creating…' : 'Create phase'}
          </button>
        </div>
      </div>
    </section>
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
  { value: 'datetime', label: 'Date & time' },
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
      subtitle={`The work-order vocabulary: ${items.length} fields, in the default order every user starts from${unused ? ` · ${unused} unused` : ''} — plus the status pipeline below`}
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

      {/* The status engine — moved here from the old Workflows tab when that
          slot became Automations: statuses are vocabulary, like fields. */}
      <StatusEditor />
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

