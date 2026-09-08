// Check-in / check-out as a VISIT LOG (0021).
//
// One card, used in two places so they cannot drift: the CICO tab renders it
// on its own, and the All-fields tab renders it (`embedded`) in place of the
// CICO section's rows. It has three parts:
//
//   1. The log — one row per visit (type, tech, method, both stamps to the
//      second, time on site), a summary strip above it, and a status select
//      on every row: moving it to "Checked in" / "Checked out" stamps the
//      time on the API. A chevron in the head folds the earlier visits away.
//   2. "New visit" — type first (Assessment, Job, Return trip), then the tech
//      and the method, which arrives pre-filled from the FM's entry in the
//      check-in method table (Admin › Custom fields).
//   3. Site access — the CICO fields that do not change between visits (IVR
//      link, pin, sign-off link), as plain rows with the per-field history.
//
// The old status / stamp / method fields mirror the latest visit and are not
// edited here or anywhere else by hand.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  CICO_SECTION_SLUG,
  DEFAULT_VISIT_TYPES,
  VISIT_HIDDEN_KEYS,
  VISIT_METHODS,
  VISIT_MIRROR_KEYS,
  fieldSectionPermKey,
  type ActivityEntry,
  type VisitInput,
  type VisitStatus,
  type WoVisit,
} from '@theone/shared';
import {
  ApiRequestError,
  createVisit,
  deleteVisit,
  getVisitHistory,
  listVisits,
  updateVisit,
  type WorkOrderDetailV2,
} from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DASH, feedTime, initials } from '../../lib/fields';
import { describeVisitChange } from '../../lib/auditFormat';
import { FIELD_SECTIONS } from '../../lib/woFieldSections';
import { ConfirmDialog } from '../ConfirmDialog';
import { Icon } from '../Icon';
import { InlineField, useWoCatalogue } from './fieldEdit';
import { FieldHistory, HistoryToggle, useCanViewHistory } from './FieldHistory';

const CICO_PERM_KEY = fieldSectionPermKey(CICO_SECTION_SLUG);
const HIDDEN = new Set(VISIT_HIDDEN_KEYS.map((k) => `fields.${k}`));
const VISIT_TYPE_KEY = `fields.${VISIT_MIRROR_KEYS.visitType}`;
const FOLD_PREF = 'wo.cico.collapsed';

/** The status select's vocabulary: three states, the last one twice because
    "checked out, but somebody has to go back" is its own outcome. */
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'planned', label: 'Not checked in' },
  { value: 'checked_in', label: 'Checked in' },
  { value: 'checked_out', label: 'Checked out' },
  { value: 'checked_out:rtn', label: 'Checked out · return trip needed' },
];

function statusValueOf(v: WoVisit): string {
  return v.status === 'checked_out' && v.return_trip_needed ? 'checked_out:rtn' : v.status;
}

function patchForStatus(value: string): VisitInput {
  if (value === 'checked_out:rtn') return { status: 'checked_out', return_trip_needed: true };
  return { status: value as VisitStatus, return_trip_needed: false };
}

// ── Time helpers ─────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

interface StampParts { day: string; hm: string; sec: string }

/** '15 Jul' · '07:04' · ':12' in the viewer's local time. */
function stampParts(iso: string | null): StampParts | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return {
    day: `${two(d.getDate())} ${MONTHS[d.getMonth()]}`,
    hm: `${two(d.getHours())}:${two(d.getMinutes())}`,
    sec: `:${two(d.getSeconds())}`,
  };
}

function durationText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${two(m % 60)}m` : `${m}m`;
}

/** Milliseconds on site: to the check-out, or to now while checked in. */
function onSiteMs(v: WoVisit, now: number): number {
  if (!v.checked_in_at) return 0;
  const a = Date.parse(v.checked_in_at);
  const b = v.checked_out_at ? Date.parse(v.checked_out_at) : v.status === 'checked_in' ? now : NaN;
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, b - a);
}

/** ISO (UTC) → the value a datetime-local input holds, in local time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** datetime-local (local time, no zone) → ISO the API stores. */
function fromLocalInput(s: string): string | null {
  if (!s.trim()) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function readFold(): boolean {
  try {
    return localStorage.getItem(FOLD_PREF) === '1';
  } catch {
    return false;
  }
}

function writeFold(v: boolean): void {
  try {
    localStorage.setItem(FOLD_PREF, v ? '1' : '0');
  } catch {
    /* a private window only loses the preference */
  }
}

// ── The card ─────────────────────────────────────────────────────────────────

interface CicoCardProps {
  wo: WorkOrderDetailV2;
  /** Rendered inside the All-fields sections grid (spans the full width). */
  embedded?: boolean;
}

export function CicoCard({ wo, embedded }: CicoCardProps) {
  const { can } = useAuth();
  const canSeeLog = can(CICO_PERM_KEY, 'view');
  const canEditLog = canSeeLog && can('work_orders', 'edit') && can(CICO_PERM_KEY, 'edit');
  const byKey = useWoCatalogue();

  // The CICO section minus the five keys the log owns: IVR link, pin, sign-off.
  const keys = FIELD_SECTIONS.find((s) => s.slug === CICO_SECTION_SLUG)?.keys ?? [];
  const accessFields = keys
    .filter((k) => !HIDDEN.has(k))
    .map((k) => byKey.get(k))
    .filter((f): f is NonNullable<typeof f> => Boolean(f));
  const visitTypes = useMemo(() => {
    const opts = byKey.get(VISIT_TYPE_KEY)?.options?.map((o) => o.value).filter(Boolean) ?? [];
    return opts.length ? opts : DEFAULT_VISIT_TYPES;
  }, [byKey]);

  const visitsQuery = useQuery({
    queryKey: ['wo-visits', wo.id],
    queryFn: () => listVisits(wo.id),
    enabled: canSeeLog,
    retry: 0,
  });
  const visits = visitsQuery.data?.items ?? [];

  const [collapsed, setCollapsed] = useState(readFold);
  const toggleFold = () => {
    setCollapsed((c) => {
      writeFold(!c);
      return !c;
    });
  };

  // One history drawer open at a time among the site-access rows.
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const toggleHistory = (key: string) => setHistoryFor((cur) => (cur === key ? null : key));

  return (
    <section className={`card card-cico${embedded ? ' afp-sect is-wide' : ''}`}>
      {/* Embedded, the head is the same section title every All-fields card
          wears (no card-head band); on the tab it is the ordinary card head. */}
      {embedded ? (
        <h3 className="afp-sect-title">
          <Icon name="check-circle" size={14} />
          CICO
          {canSeeLog && <HeadRight visits={visits} collapsed={collapsed} onFold={toggleFold} />}
        </h3>
      ) : (
        <div className="card-head">
          <h2 className="card-title">Check-in / check-out</h2>
          {canSeeLog && <HeadRight visits={visits} collapsed={collapsed} onFold={toggleFold} />}
        </div>
      )}

      {canSeeLog && (
        <VisitLog
          wo={wo}
          visits={visits}
          loading={visitsQuery.isLoading}
          failed={visitsQuery.isError}
          fm={visitsQuery.data?.fm ?? null}
          defaultMethod={visitsQuery.data?.default_method ?? null}
          defaultDetail={visitsQuery.data?.default_method_detail ?? null}
          collapsed={collapsed}
          onExpand={() => { setCollapsed(false); writeFold(false); }}
          canEdit={canEditLog}
          visitTypes={visitTypes}
        />
      )}

      {accessFields.length > 0 && (
        <>
          <dl className="fieldlist cv-access">
            {accessFields.map((f) => (
              <div key={f.key}>
                <div className="fieldrow has-hist">
                  <dt>{f.label}</dt>
                  <dd>
                    <InlineField wo={wo} fieldKey={f.key} label={f.label} />
                    <HistoryToggle
                      field={f}
                      open={historyFor === f.key}
                      onToggle={() => toggleHistory(f.key)}
                    />
                  </dd>
                </div>
                {historyFor === f.key && <FieldHistory woId={wo.id} field={f} />}
              </div>
            ))}
          </dl>
        </>
      )}

      {!canSeeLog && accessFields.length === 0 && (
        <div className="empty-flat">Check-in / check-out is not available to your role.</div>
      )}
    </section>
  );
}

// ── Head: the live state chip and the fold ───────────────────────────────────

function HeadRight({ visits, collapsed, onFold }: { visits: WoVisit[]; collapsed: boolean; onFold: () => void }) {
  return (
    <span className="cv-headright">
      <StateChip visits={visits} />
      {visits.length > 1 && (
        <button
          type="button"
          className="afp-act cv-fold"
          title={collapsed ? `Show all ${visits.length} visits` : 'Hide the earlier visits'}
          aria-label={collapsed ? `Show all ${visits.length} visits` : 'Hide the earlier visits'}
          aria-expanded={!collapsed}
          onClick={onFold}
        >
          <Icon name={collapsed ? 'chev-d' : 'chev-u'} size={14} />
        </button>
      )}
    </span>
  );
}

function StateChip({ visits }: { visits: WoVisit[] }) {
  const open = [...visits].reverse().find((v) => v.status === 'checked_in');
  if (open) {
    return (
      <span className="chip chip-warn">
        <span className="pill-dot" aria-hidden="true" />
        On site · {open.visit_type}
      </span>
    );
  }
  const last = visits[visits.length - 1];
  if (!last) return null;
  if (last.status === 'checked_out') {
    return last.return_trip_needed
      ? <span className="chip chip-danger">Return trip needed</span>
      : <span className="chip chip-ok">Checked out</span>;
  }
  return <span className="chip chip-outline">Visit {last.seq} not checked in</span>;
}

// ── The log ──────────────────────────────────────────────────────────────────

interface VisitLogProps {
  wo: WorkOrderDetailV2;
  visits: WoVisit[];
  loading: boolean;
  failed: boolean;
  fm: string | null;
  defaultMethod: string | null;
  defaultDetail: string | null;
  collapsed: boolean;
  onExpand: () => void;
  canEdit: boolean;
  visitTypes: string[];
}

function VisitLog({
  wo, visits, loading, failed, fm, defaultMethod, defaultDetail, collapsed, onExpand, canEdit, visitTypes,
}: VisitLogProps) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canAdmin = can('admin/fields', 'view');

  // A running "on site" figure ticks while somebody is checked in.
  const [now, setNow] = useState(() => Date.now());
  const hasOpen = visits.some((v) => v.status === 'checked_in');
  useEffect(() => {
    if (!hasOpen) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [hasOpen, visits]);

  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = (opts?: { deleted?: boolean }) => {
    void qc.invalidateQueries({ queryKey: ['wo-visits', wo.id] });
    // The mirrored fields moved: the detail, the list, the trail, the histories.
    void qc.invalidateQueries({ queryKey: ['work-orders'] });
    void qc.invalidateQueries({ queryKey: ['wo-activity'] });
    void qc.invalidateQueries({ queryKey: ['wo-feed'] });
    void qc.invalidateQueries({ queryKey: ['wo-field-history', wo.id] });
    // Not after a delete: the removed visit's drawer is unmounting and a
    // refetch of its history would only 404.
    if (!opts?.deleted) void qc.invalidateQueries({ queryKey: ['wo-visit-history'] });
  };
  const fail = (err: unknown) =>
    setError(err instanceof ApiRequestError ? err.message : 'Could not save the visit');

  const create = useMutation({
    mutationFn: (input: VisitInput) => createVisit(wo.id, input),
    onSuccess: () => { invalidate(); setComposing(false); setError(null); },
    onError: fail,
  });
  const update = useMutation({
    mutationFn: (v: { id: string; input: VisitInput }) => updateVisit(v.id, v.input),
    onSuccess: () => { invalidate(); setError(null); },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteVisit(id),
    onSuccess: () => { invalidate({ deleted: true }); setError(null); },
    onError: fail,
  });
  const busy = create.isPending || update.isPending || remove.isPending;

  const summary = useMemo(() => {
    const techs = new Set(visits.map((v) => v.tech_name?.trim()).filter(Boolean));
    const ms = visits.reduce((n, v) => n + onSiteMs(v, now), 0);
    const lastOut = visits
      .map((v) => v.checked_out_at)
      .filter((s): s is string => Boolean(s))
      .sort()
      .pop() ?? null;
    return { count: visits.length, techs: techs.size, ms, lastOut: stampParts(lastOut) };
  }, [visits, now]);

  const shown = collapsed && visits.length > 1 ? visits.slice(-1) : visits;
  const hidden = visits.length - shown.length;

  return (
    <>
      {visits.length > 0 && (
        <div className="cv-sum">
          <div><span className="cv-sum-k">Visits</span><span className="cv-sum-v">{summary.count}</span></div>
          <div><span className="cv-sum-k">Time on site</span><span className="cv-sum-v">{summary.ms ? durationText(summary.ms) : DASH}</span></div>
          <div><span className="cv-sum-k">Techs</span><span className="cv-sum-v">{summary.techs || DASH}</span></div>
          <div>
            <span className="cv-sum-k">Last check-out</span>
            <span className="cv-sum-v">
              {summary.lastOut ? <>{summary.lastOut.day}<small>{summary.lastOut.hm}</small></> : DASH}
            </span>
          </div>
        </div>
      )}

      {loading ? (
        <div className="empty-flat">Loading visits…</div>
      ) : failed ? (
        <div className="empty-flat">Could not load the visits — GET /api/work-orders/:id/visits did not respond.</div>
      ) : visits.length === 0 ? (
        <div className="empty-flat cv-empty">No visit logged yet.</div>
      ) : (
        <ol className="cv-list">
          {hidden > 0 && (
            <li className="cv-more">
              <button type="button" className="linkbtn" onClick={onExpand}>
                <Icon name="chev-d" size={12} />
                Show all {visits.length} visits ({hidden} earlier)
              </button>
            </li>
          )}
          {shown.map((v) => (
            <VisitRow
              key={v.id}
              v={v}
              now={now}
              canEdit={canEdit}
              busy={busy}
              visitTypes={visitTypes}
              onPatch={(input) => update.mutate({ id: v.id, input })}
              onDelete={() => remove.mutate(v.id)}
            />
          ))}
        </ol>
      )}

      {error && <p className="afp-error cv-error" role="alert">{error}</p>}

      {canEdit && (
        composing ? (
          <VisitComposer
            visitTypes={visitTypes}
            fm={fm}
            defaultMethod={defaultMethod}
            defaultDetail={defaultDetail}
            busy={create.isPending}
            onCancel={() => { setComposing(false); setError(null); }}
            onSubmit={(input) => create.mutate(input)}
          />
        ) : (
          <div className="cv-foot">
            <button type="button" className="btn btn-sm" onClick={() => setComposing(true)} disabled={busy}>
              <Icon name="plus" size={14} />
              New visit
            </button>
            {fm && !defaultMethod && (
              <span className="cv-hint">
                No check-in method on file for <b>{fm.trim()}</b>
                {canAdmin ? <> — <Link to="/admin/fields">add it in Admin › Custom fields</Link></> : null}.
              </span>
            )}
          </div>
        )
      )}
    </>
  );
}

// ── One visit ────────────────────────────────────────────────────────────────

interface VisitRowProps {
  v: WoVisit;
  now: number;
  canEdit: boolean;
  busy: boolean;
  visitTypes: string[];
  onPatch: (input: VisitInput) => void;
  onDelete: () => void;
}

function VisitRow({ v, now, canEdit, busy, visitTypes, onPatch, onDelete }: VisitRowProps) {
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const canHistory = useCanViewHistory();

  const open = v.status === 'checked_in';
  const done = v.status === 'checked_out';
  const cin = stampParts(v.checked_in_at);
  const cout = stampParts(v.checked_out_at);
  const ms = onSiteMs(v, now);

  return (
    <li className={`cv-visit${open ? ' is-open' : ''}${done ? ' is-done' : ''}`}>
      <div className="cv-rail" aria-hidden="true">
        <span className="cv-node" />
        <span className="cv-line" />
      </div>

      <div className="cv-body">
        <div className="cv-vhead">
          <span className="cv-n">Visit {v.seq}</span>
          <span className="cv-type">{v.visit_type}</span>
          {v.tech_name && (
            <span className="cv-tech">
              · <b>{v.tech_name}</b>
              {v.tech_phone && <a className="cv-phone" href={`tel:${v.tech_phone}`}>{v.tech_phone}</a>}
            </span>
          )}
          {open && (
            <span className="chip chip-warn">
              <span className="pill-dot" aria-hidden="true" />
              On site · {durationText(ms)}
            </span>
          )}
        </div>

        {editing ? (
          <VisitEditForm
            v={v}
            visitTypes={visitTypes}
            busy={busy}
            onCancel={() => setEditing(false)}
            onSave={(input) => { onPatch(input); setEditing(false); }}
          />
        ) : (
          <>
            <div className="cv-stamps">
              <span className="cv-k">Checked in</span>
              <span className="cv-k">Checked out</span>
              <span className="cv-k">On site</span>
              <StampCell parts={cin} />
              <StampCell parts={cout} sameDayAs={cin} live={open} />
              <span className="cv-v">
                {done && cin && cout ? durationText(ms) : open ? <span className="cv-sub">running</span> : DASH}
              </span>
              <span className="cv-sub">{v.checked_in_by ? `by ${v.checked_in_by.display_name}` : ''}</span>
              <span className="cv-sub">{v.checked_out_by ? `by ${v.checked_out_by.display_name}` : ''}</span>
              <span />
            </div>
            <div className="cv-meta">
              {v.method && <span className="chip" title="Check-in method">{v.method}</span>}
              {v.method_detail && <span className="cv-detail">{v.method_detail}</span>}
              {done && (v.return_trip_needed
                ? <span className="chip chip-danger">Return trip needed</span>
                : <span className="chip chip-ok">Completed</span>)}
              {v.status === 'planned' && <span className="chip chip-outline">Not checked in</span>}
            </div>
          </>
        )}
      </div>

      <div className="cv-act">
        {canEdit && (
          <select
            className="fld cv-status"
            value={statusValueOf(v)}
            disabled={busy}
            aria-label={`Status of visit ${v.seq}`}
            onChange={(e) => onPatch(patchForStatus(e.target.value))}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}
        <span className="cv-icons">
          {canHistory && (
            <button
              type="button"
              className={`afp-act${history ? ' is-on' : ''}`}
              title="History of this visit"
              aria-label={`History of visit ${v.seq}`}
              aria-expanded={history}
              onClick={() => setHistory((h) => !h)}
            >
              <Icon name="history" size={12} />
            </button>
          )}
          {canEdit && !editing && (
            <button
              type="button"
              className="afp-act"
              title="Edit this visit"
              aria-label={`Edit visit ${v.seq}`}
              onClick={() => setEditing(true)}
            >
              <Icon name="pencil" size={12} />
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="afp-act cv-del"
              title="Delete this visit"
              aria-label={`Delete visit ${v.seq}`}
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              <Icon name="trash" size={12} />
            </button>
          )}
        </span>
      </div>

      {history && <VisitHistory visitId={v.id} />}

      {confirming && (
        <ConfirmDialog
          title={`Delete visit ${v.seq}?`}
          message={<>Visit {v.seq} · {v.visit_type}{v.tech_name ? ` (${v.tech_name})` : ''} will be removed from this work order.</>}
          note="The audit trail keeps a record of the visit and of this deletion. The old check-in/out fields will read the visit before it."
          confirmLabel="Delete visit"
          danger
          busy={busy}
          onConfirm={() => { setConfirming(false); onDelete(); }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </li>
  );
}

function StampCell({ parts, sameDayAs, live }: { parts: StampParts | null; sameDayAs?: StampParts | null; live?: boolean }) {
  if (!parts) return <span className={`cv-v${live ? ' is-live' : ''}`}>{DASH}</span>;
  const hideDay = Boolean(sameDayAs && sameDayAs.day === parts.day);
  return (
    <span className="cv-v">
      {!hideDay && <span className="cv-day">{parts.day}</span>}
      {parts.hm}
      <span className="cv-sec">{parts.sec}</span>
    </span>
  );
}

// ── Editing a visit ──────────────────────────────────────────────────────────

function VisitEditForm({ v, visitTypes, busy, onCancel, onSave }: {
  v: WoVisit;
  visitTypes: string[];
  busy: boolean;
  onCancel: () => void;
  onSave: (input: VisitInput) => void;
}) {
  const [type, setType] = useState(v.visit_type);
  const [tech, setTech] = useState(v.tech_name ?? '');
  const [phone, setPhone] = useState(v.tech_phone ?? '');
  const [method, setMethod] = useState(v.method ?? '');
  const [detail, setDetail] = useState(v.method_detail ?? '');
  const [inAt, setInAt] = useState(toLocalInput(v.checked_in_at));
  const [outAt, setOutAt] = useState(toLocalInput(v.checked_out_at));

  const types = visitTypes.includes(v.visit_type) ? visitTypes : [v.visit_type, ...visitTypes];
  const methods: string[] = v.method && !(VISIT_METHODS as readonly string[]).includes(v.method)
    ? [v.method, ...VISIT_METHODS]
    : [...VISIT_METHODS];

  const submit = () => {
    // Only what changed goes over the wire, so an untouched stamp is never
    // rewritten (and never re-stamped by the status logic).
    const input: VisitInput = {};
    if (type !== v.visit_type) input.visit_type = type;
    if (tech.trim() !== (v.tech_name ?? '')) input.tech_name = tech.trim() || null;
    if (phone.trim() !== (v.tech_phone ?? '')) input.tech_phone = phone.trim() || null;
    if (method !== (v.method ?? '')) input.method = method || null;
    if (detail.trim() !== (v.method_detail ?? '')) input.method_detail = detail.trim() || null;
    if (inAt !== toLocalInput(v.checked_in_at)) input.checked_in_at = fromLocalInput(inAt);
    if (outAt !== toLocalInput(v.checked_out_at)) input.checked_out_at = fromLocalInput(outAt);
    if (Object.keys(input).length === 0) { onCancel(); return; }
    onSave(input);
  };

  return (
    <form
      className="cv-form"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
    >
      <div className="cv-form-row">
        <label className="field">
          <span className="lbl">Visit type</span>
          <select className="fld" value={type} onChange={(e) => setType(e.target.value)} disabled={busy}>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="lbl">Technician</span>
          <input className="fld" value={tech} onChange={(e) => setTech(e.target.value)} placeholder="Name" disabled={busy} />
        </label>
        <label className="field">
          <span className="lbl">Phone</span>
          <input className="fld" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(000) 000-0000" disabled={busy} />
        </label>
        <label className="field">
          <span className="lbl">Method</span>
          <select className="fld" value={method} onChange={(e) => setMethod(e.target.value)} disabled={busy}>
            <option value="">—</option>
            {methods.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="field cv-detailfield">
          <span className="lbl">Method detail</span>
          <input className="fld" value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="IVR number, portal, where to submit…" disabled={busy} />
        </label>
      </div>
      <div className="cv-form-row">
        <label className="field">
          <span className="lbl">Checked in</span>
          <input className="fld" type="datetime-local" step={1} value={inAt} onChange={(e) => setInAt(e.target.value)} disabled={busy} />
        </label>
        <label className="field">
          <span className="lbl">Checked out</span>
          <input className="fld" type="datetime-local" step={1} value={outAt} onChange={(e) => setOutAt(e.target.value)} disabled={busy} />
        </label>
      </div>
      <div className="cv-form-foot">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          <Icon name="check" size={14} />
          Save visit
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <span className="cv-hint">A corrected time keeps its history — the clock on the row shows who changed what.</span>
      </div>
    </form>
  );
}

// ── Logging a new visit ──────────────────────────────────────────────────────

function VisitComposer({ visitTypes, fm, defaultMethod, defaultDetail, busy, onCancel, onSubmit }: {
  visitTypes: string[];
  fm: string | null;
  defaultMethod: string | null;
  defaultDetail: string | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: VisitInput) => void;
}) {
  const [type, setType] = useState<string>('');
  const [tech, setTech] = useState('');
  const [phone, setPhone] = useState('');
  const [method, setMethod] = useState(defaultMethod ?? '');
  const [detail, setDetail] = useState(defaultDetail ?? '');
  const [touched, setTouched] = useState(false);

  // Picking a different method than the FM's drops the FM's instruction (an
  // IVR number is no help on a portal visit); picking it back restores it.
  const pickMethod = (m: string) => {
    setMethod(m);
    setDetail(m === defaultMethod ? (defaultDetail ?? '') : '');
  };

  const submit = () => {
    setTouched(true);
    if (!type) return;
    onSubmit({
      visit_type: type,
      tech_name: tech.trim() || null,
      tech_phone: phone.trim() || null,
      method: method || null,
      method_detail: detail.trim() || null,
    });
  };

  return (
    <form
      className="cv-composer"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
    >
      <div className="cv-form-row">
        <div className="field cv-typefield">
          <span className={`lbl${touched && !type ? ' is-missing' : ''}`}>Visit type</span>
          <div className="seg cv-types" role="group" aria-label="Visit type">
            {visitTypes.map((t) => (
              <button
                key={t}
                type="button"
                className={`seg-btn${type === t ? ' is-on' : ''}`}
                aria-pressed={type === t}
                onClick={() => setType(t)}
                disabled={busy}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span className="lbl">Technician</span>
          <input className="fld" value={tech} onChange={(e) => setTech(e.target.value)} placeholder="Name" disabled={busy} autoFocus />
        </label>
        <label className="field">
          <span className="lbl">Phone</span>
          <input className="fld" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(000) 000-0000" disabled={busy} />
        </label>
        <label className="field">
          <span className="lbl">Method</span>
          <select className="fld" value={method} onChange={(e) => pickMethod(e.target.value)} disabled={busy}>
            <option value="">—</option>
            {VISIT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="field cv-detailfield">
          <span className="lbl">Method detail</span>
          <input
            className="fld"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="IVR number, portal, where to submit…"
            disabled={busy}
          />
        </label>
      </div>
      <div className="cv-form-foot">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          <Icon name="plus" size={14} />
          Log visit
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        {touched && !type && <span className="cv-hint">Pick the visit type first.</span>}
      </div>
    </form>
  );
}

// ── Per-visit history ────────────────────────────────────────────────────────

function VisitHistory({ visitId }: { visitId: string }) {
  const q = useQuery({
    queryKey: ['wo-visit-history', visitId],
    queryFn: () => getVisitHistory(visitId),
    retry: 0,
  });

  let body: ReactNode;
  if (q.isLoading) {
    body = <span className="afp-none">Loading history…</span>;
  } else if (q.isError) {
    const forbidden = q.error instanceof ApiRequestError && q.error.status === 403;
    body = <span className="afp-none">{forbidden ? 'Your role cannot view history.' : 'History unavailable.'}</span>;
  } else {
    const items = q.data?.items ?? [];
    body = items.length === 0
      ? <span className="afp-none">No recorded changes.</span>
      : (
        <ol className="afp-history cv-history">
          {items.map((e: ActivityEntry) => {
            const who = e.actor?.display_name ?? 'System';
            return (
              <li key={e.id} className="afp-hrow">
                <span className={`audit-av${e.actor?.kind === 'service' ? ' is-service' : ''}`} aria-hidden="true">
                  {initials(who)}
                </span>
                <p className="afp-htext"><b>{who}</b> {describeVisitChange(e.before, e.after)}</p>
                <time className="audit-time" dateTime={e.created_at}>{feedTime(e.created_at)}</time>
              </li>
            );
          })}
        </ol>
      );
  }
  return <div className="cv-hist-wrap">{body}</div>;
}
