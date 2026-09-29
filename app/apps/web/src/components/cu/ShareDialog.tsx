/* Client Updates (0055) — how a tracker reaches the client.
 *
 * Four tabs: Email (who, what it says, preview, test, send now), Schedule
 * (when it goes out by itself), Client link (a read-only page anyone with the
 * link can open) and History (what was sent, to whom, and whether it went).
 * Everything is sent from the company address the server is configured with
 * (contact@seamlessfm.com); the dialog says plainly when email is not set up.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SCHEDULE_FREQUENCIES,
  SCHEDULE_FREQUENCY_LABELS,
  WEEKDAY_LABELS,
  DEFAULT_SCHEDULE,
  defaultSubject,
  describeSchedule,
  formatRecipient,
  nextRunAt,
  parseRecipients,
  sharePath,
  shareLinkLive,
  sharedColumns,
  type ClientUpdate,
  type ClientUpdateSchedule,
  type MailStatus,
} from '@theone/shared';
import {
  ApiRequestError,
  getClientUpdateEmailPreview,
  listClientUpdateDeliveries,
  sendClientUpdate,
  setClientUpdateLink,
  updateClientUpdate,
} from '../../api/client';
import { Icon } from '../Icon';
import { CopyButton } from '../CopyButton';

type Tab = 'email' | 'schedule' | 'link' | 'history';

const TABS: { id: Tab; label: string }[] = [
  { id: 'email', label: 'Email' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'link', label: 'Client link' },
  { id: 'history', label: 'History' },
];

const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : fallback);

const WHEN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
export const whenCT = (iso: string | null | undefined) => (iso ? `${WHEN.format(new Date(iso))} CT` : '—');

export function ShareDialog({
  tracker,
  mail,
  labelOf,
  initialTab = 'email',
  onClose,
}: {
  tracker: ClientUpdate;
  mail: MailStatus | undefined;
  labelOf: (key: string) => string;
  initialTab?: Tab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = tracker.client ? `${tracker.client} · ${tracker.name}` : tracker.name;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal modal-wide cu-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cu-share-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="cu-share-title">Share · {title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="seg cu-tabs" role="tablist" aria-label="Sharing">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`seg-btn${tab === t.id ? ' is-on' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="modal-body cu-dialog-body">
          <SharedColumnsNote tracker={tracker} labelOf={labelOf} />
          {tab === 'email' && <EmailTab tracker={tracker} mail={mail} onSent={() => setTab('history')} />}
          {tab === 'schedule' && <ScheduleTab tracker={tracker} mail={mail} />}
          {tab === 'link' && <LinkTab tracker={tracker} />}
          {tab === 'history' && <HistoryTab tracker={tracker} />}
        </div>
      </div>
    </div>
  );
}

function SharedColumnsNote({ tracker, labelOf }: { tracker: ClientUpdate; labelOf: (k: string) => string }) {
  const shared = sharedColumns(tracker.columns);
  const hidden = tracker.columns.filter((c) => !c.shared);
  return (
    <div className="cu-shared-note">
      <span className="cu-shared-label">The client sees</span>
      <span className="cu-chips">
        {shared.map((c) => (
          <span key={c.key} className="chip chip-sm">
            {c.label ?? labelOf(c.key)}
          </span>
        ))}
      </span>
      {hidden.length > 0 && (
        <span className="hint">
          Hidden from them: {hidden.map((c) => c.label ?? labelOf(c.key)).join(', ')}. Change this in Settings.
        </span>
      )}
    </div>
  );
}

function MailBanner({ mail }: { mail: MailStatus | undefined }) {
  if (!mail || mail.configured) return null;
  return (
    <p className="cu-banner" role="status">
      <Icon name="alert-circle" size={14} />
      Email is not switched on for this site yet, so Send will not go out. An admin sets the mail provider on the
      server (Microsoft 365 for {mail.from}); preview and the client link work today.
    </p>
  );
}

// ── Email ────────────────────────────────────────────────────────────────────

function EmailTab({ tracker, mail, onSent }: { tracker: ClientUpdate; mail: MailStatus | undefined; onSent: () => void }) {
  const qc = useQueryClient();
  const [to, setTo] = useState(tracker.email.to.map(formatRecipient).join(', '));
  const [cc, setCc] = useState(tracker.email.cc.map(formatRecipient).join(', '));
  const [subject, setSubject] = useState(tracker.email.subject ?? '');
  const [intro, setIntro] = useState(tracker.email.intro ?? '');
  const [attachCsv, setAttachCsv] = useState(tracker.email.attach_csv);
  const [includeLink, setIncludeLink] = useState(tracker.email.include_link);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const toParsed = useMemo(() => parseRecipients(to), [to]);
  const ccParsed = useMemo(() => parseRecipients(cc), [cc]);
  const invalid = [...toParsed.invalid, ...ccParsed.invalid];
  const linkLive = shareLinkLive(tracker.share, new Date());
  const title = tracker.client ? `${tracker.client} · ${tracker.name}` : tracker.name;

  const emailInput = () => ({
    subject: subject.trim() || null,
    intro: intro.trim() || null,
    to: toParsed.recipients,
    cc: ccParsed.recipients,
    attach_csv: attachCsv,
    include_link: includeLink,
  });
  const dirty =
    JSON.stringify(emailInput()) !==
    JSON.stringify({
      subject: tracker.email.subject,
      intro: tracker.email.intro,
      to: tracker.email.to,
      cc: tracker.email.cc,
      attach_csv: tracker.email.attach_csv,
      include_link: tracker.email.include_link,
    });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['client-updates'] });
    qc.invalidateQueries({ queryKey: ['cu-deliveries', tracker.id] });
  };

  const save = useMutation({
    mutationFn: () => updateClientUpdate(tracker.id, { name: tracker.name, email: emailInput() }),
    onSuccess: () => {
      setNote({ tone: 'ok', text: 'Saved.' });
      refresh();
    },
    onError: (e) => setNote({ tone: 'err', text: errText(e, 'That did not save') }),
  });

  const loadPreview = useMutation({
    mutationFn: async () => {
      if (dirty) await updateClientUpdate(tracker.id, { name: tracker.name, email: emailInput() });
      return getClientUpdateEmailPreview(tracker.id);
    },
    onSuccess: (p) => {
      setPreview(p.html);
      refresh();
    },
    onError: (e) => setNote({ tone: 'err', text: errText(e, 'The preview could not be built') }),
  });

  const send = useMutation({
    mutationFn: async (trigger: 'manual' | 'test') => {
      if (dirty) await updateClientUpdate(tracker.id, { name: tracker.name, email: emailInput() });
      return sendClientUpdate(tracker.id, { trigger });
    },
    onSuccess: ({ delivery }) => {
      setConfirming(false);
      refresh();
      if (delivery.status === 'sent') {
        setNote({
          tone: 'ok',
          text:
            delivery.trigger === 'test'
              ? `Test sent to ${delivery.to.join(', ')}.`
              : `Sent to ${delivery.to.length + delivery.cc.length} ${delivery.to.length + delivery.cc.length === 1 ? 'person' : 'people'} with ${delivery.row_count} work orders.`,
        });
        if (delivery.trigger !== 'test') onSent();
      } else {
        setNote({ tone: 'err', text: delivery.error ?? 'The email did not go out.' });
      }
    },
    onError: (e) => {
      setConfirming(false);
      setNote({ tone: 'err', text: errText(e, 'The email did not go out') });
    },
  });

  const busy = save.isPending || send.isPending || loadPreview.isPending;
  const people = toParsed.recipients.length + ccParsed.recipients.length;

  return (
    <div className="cu-tab">
      <MailBanner mail={mail} />
      <div className="cu-grid">
        <label className="field cu-wide">
          <span className="lbl">To</span>
          <textarea
            className="fld"
            rows={2}
            value={to}
            placeholder="name@client.com, Another Person <another@client.com>"
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label className="field cu-wide">
          <span className="lbl">Cc</span>
          <input className="fld" value={cc} placeholder="Our account manager, their regional lead…" onChange={(e) => setCc(e.target.value)} />
        </label>
        {invalid.length > 0 && (
          <p className="modal-error cu-wide">Not email addresses: {invalid.join(', ')}</p>
        )}
        <label className="field cu-wide">
          <span className="lbl">Subject</span>
          <input
            className="fld"
            value={subject}
            placeholder={defaultSubject(title, new Date())}
            maxLength={300}
            onChange={(e) => setSubject(e.target.value)}
          />
          <span className="hint">Left blank, the subject carries the day it is sent.</span>
        </label>
        <label className="field cu-wide">
          <span className="lbl">Message above the table</span>
          <textarea
            className="fld"
            rows={3}
            value={intro}
            maxLength={4000}
            placeholder="Hi team, here is where every open work order stands today. Items waiting on you are listed first."
            onChange={(e) => setIntro(e.target.value)}
          />
        </label>
        <label className="sw">
          <input type="checkbox" checked={attachCsv} onChange={(e) => setAttachCsv(e.target.checked)} />
          <span className="sw-track" />
          Attach the list as a spreadsheet (CSV)
        </label>
        <label className="sw">
          <input type="checkbox" checked={includeLink} onChange={(e) => setIncludeLink(e.target.checked)} />
          <span className="sw-track" />
          Add an “Open the live tracker” button {linkLive ? '' : '(turn the client link on first)'}
        </label>
      </div>

      {note && (
        <p className={note.tone === 'ok' ? 'hint cu-ok' : 'modal-error'} role={note.tone === 'ok' ? 'status' : 'alert'}>
          {note.text}
        </p>
      )}

      {confirming ? (
        <div className="cu-confirm" role="alertdialog" aria-label="Confirm send">
          <span>
            Send this update to {people} {people === 1 ? 'person' : 'people'} now, from {mail?.from ?? 'the company address'}?
          </span>
          <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>
            Not yet
          </button>
          <button type="button" className={`btn btn-primary${send.isPending ? ' is-busy' : ''}`} onClick={() => send.mutate('manual')} disabled={busy}>
            <Icon name="send" size={14} /> {send.isPending ? 'Sending…' : 'Send now'}
          </button>
        </div>
      ) : (
        <div className="cu-actions">
          <button type="button" className="btn btn-ghost" onClick={() => save.mutate()} disabled={busy || !dirty || invalid.length > 0}>
            Save
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => loadPreview.mutate()} disabled={busy || invalid.length > 0}>
            <Icon name="file" size={14} /> {loadPreview.isPending ? 'Building…' : 'Preview'}
          </button>
          <button type="button" className="btn" onClick={() => send.mutate('test')} disabled={busy || invalid.length > 0}>
            Send a test to me
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setConfirming(true)}
            disabled={busy || invalid.length > 0 || toParsed.recipients.length === 0}
            title={toParsed.recipients.length === 0 ? 'Add at least one address in To' : undefined}
          >
            <Icon name="send" size={14} /> Send now
          </button>
        </div>
      )}

      {preview && (
        <div className="cu-preview">
          <div className="cu-preview-head">
            <span>Preview · what the client receives</span>
            <button type="button" className="icon-btn" aria-label="Close preview" onClick={() => setPreview(null)}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <iframe title="Email preview" className="cu-preview-frame" sandbox="" srcDoc={preview} />
        </div>
      )}
    </div>
  );
}

// ── Schedule ─────────────────────────────────────────────────────────────────

function ScheduleTab({ tracker, mail }: { tracker: ClientUpdate; mail: MailStatus | undefined }) {
  const qc = useQueryClient();
  const [s, setS] = useState<ClientUpdateSchedule>(tracker.schedule ?? DEFAULT_SCHEDULE);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const next = nextRunAt(s, new Date());
  const dirty = JSON.stringify(s) !== JSON.stringify(tracker.schedule ?? DEFAULT_SCHEDULE);

  const save = useMutation({
    mutationFn: () => updateClientUpdate(tracker.id, { name: tracker.name, schedule: s }),
    onSuccess: () => {
      setNote({ tone: 'ok', text: s.enabled ? `Scheduled: ${describeSchedule(s)}.` : 'Schedule off.' });
      qc.invalidateQueries({ queryKey: ['client-updates'] });
    },
    onError: (e) => setNote({ tone: 'err', text: errText(e, 'That did not save') }),
  });

  const toggleDay = (d: number) =>
    setS({ ...s, weekdays: s.weekdays.includes(d) ? s.weekdays.filter((x) => x !== d) : [...s.weekdays, d].sort() });

  return (
    <div className="cu-tab">
      <MailBanner mail={mail} />
      <label className="sw">
        <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
        <span className="sw-track" />
        Send this update automatically
      </label>
      <div className={`cu-grid cu-grid-3${s.enabled ? '' : ' is-off'}`}>
        <label className="field">
          <span className="lbl">How often</span>
          <select
            className="fld"
            value={s.frequency}
            disabled={!s.enabled}
            onChange={(e) => setS({ ...s, frequency: e.target.value as ClientUpdateSchedule['frequency'] })}
          >
            {SCHEDULE_FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {SCHEDULE_FREQUENCY_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lbl">At (Central time)</span>
          <input
            className="fld"
            type="time"
            value={s.time}
            disabled={!s.enabled}
            onChange={(e) => setS({ ...s, time: e.target.value || '08:00' })}
          />
        </label>
        {s.frequency === 'monthly' && (
          <label className="field">
            <span className="lbl">Day of the month</span>
            <input
              className="fld"
              type="number"
              min={1}
              max={28}
              value={s.day_of_month}
              disabled={!s.enabled}
              onChange={(e) => setS({ ...s, day_of_month: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })}
            />
          </label>
        )}
      </div>
      {s.frequency === 'weekly' && (
        <div className="cu-days" role="group" aria-label="Days of the week">
          {WEEKDAY_LABELS.map((label, d) => (
            <button
              key={label}
              type="button"
              className={`seg-btn${s.weekdays.includes(d) ? ' is-on' : ''}`}
              aria-pressed={s.weekdays.includes(d)}
              disabled={!s.enabled}
              onClick={() => toggleDay(d)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <p className="hint">
        {s.enabled && next
          ? `${describeSchedule(s)}. Next: ${whenCT(next.toISOString())}. It goes to the To and Cc on the Email tab${
              tracker.email.to.length === 0 ? ', which is empty, so add recipients first' : ''
            }.`
          : 'Nothing goes out by itself. You can still send from the Email tab.'}
      </p>
      {tracker.next_run_at && !dirty && tracker.schedule?.enabled && (
        <p className="hint">The server has the next send at {whenCT(tracker.next_run_at)}.</p>
      )}
      {note && (
        <p className={note.tone === 'ok' ? 'hint cu-ok' : 'modal-error'} role={note.tone === 'ok' ? 'status' : 'alert'}>
          {note.text}
        </p>
      )}
      <div className="cu-actions">
        <button
          type="button"
          className={`btn btn-primary${save.isPending ? ' is-busy' : ''}`}
          onClick={() => save.mutate()}
          disabled={!dirty || save.isPending || (s.enabled && s.frequency === 'weekly' && s.weekdays.length === 0)}
        >
          Save schedule
        </button>
      </div>
    </div>
  );
}

// ── Client link ──────────────────────────────────────────────────────────────

function LinkTab({ tracker }: { tracker: ClientUpdate }) {
  const qc = useQueryClient();
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const live = shareLinkLive(tracker.share, new Date());
  const url = tracker.share.token ? `${window.location.origin}${sharePath(tracker.share.token)}` : null;
  const expiresDay = tracker.share.expires_at ? tracker.share.expires_at.slice(0, 10) : '';

  const done = (text: string) => () => {
    setNote({ tone: 'ok', text });
    qc.invalidateQueries({ queryKey: ['client-updates'] });
  };
  const fail = (e: unknown) => setNote({ tone: 'err', text: errText(e, 'That did not save') });

  const link = useMutation({
    mutationFn: (input: { enabled: boolean; regenerate?: boolean; expires_at?: string | null }) =>
      setClientUpdateLink(tracker.id, { ...input, origin: window.location.origin }),
    onSuccess: (_d, v) => {
      setConfirmRegen(false);
      done(v.regenerate ? 'New link made. The old one no longer works.' : v.enabled ? 'Saved.' : 'Link turned off.')();
    },
    onError: fail,
  });
  const content = useMutation({
    mutationFn: (share: { charts?: boolean; summary?: boolean }) =>
      updateClientUpdate(tracker.id, { name: tracker.name, share }),
    onSuccess: done('Saved.'),
    onError: fail,
  });

  return (
    <div className="cu-tab">
      <label className="sw">
        <input
          type="checkbox"
          checked={tracker.share.enabled}
          disabled={link.isPending}
          onChange={(e) => link.mutate({ enabled: e.target.checked })}
        />
        <span className="sw-track" />
        Anyone with the link can view this tracker (read only, no sign-in)
      </label>

      {tracker.share.enabled && url && (
        <>
          <div className="cu-link">
            <input className="fld" readOnly value={url} aria-label="Client link" onFocus={(e) => e.target.select()} />
            <CopyButton value={url} label="Copy link" />
            <a className="btn btn-ghost" href={url} target="_blank" rel="noreferrer">
              <Icon name="ext" size={12} /> Open
            </a>
          </div>
          {!live && <p className="modal-error">This link has expired. Clear or move the expiry date to open it again.</p>}
          <div className="cu-grid">
            <label className="field">
              <span className="lbl">Stops working after</span>
              <input
                className="fld"
                type="date"
                value={expiresDay}
                onChange={(e) =>
                  link.mutate({
                    enabled: true,
                    expires_at: e.target.value ? new Date(`${e.target.value}T23:59:59`).toISOString() : null,
                  })
                }
              />
              <span className="hint">Leave empty to keep it open until you turn it off.</span>
            </label>
            <div className="field cu-stack">
              <span className="lbl">On the page</span>
              <label className="sw">
                <input
                  type="checkbox"
                  checked={tracker.share.summary}
                  onChange={(e) => content.mutate({ summary: e.target.checked })}
                />
                <span className="sw-track" />
                Headline numbers
              </label>
              <label className="sw">
                <input type="checkbox" checked={tracker.share.charts} onChange={(e) => content.mutate({ charts: e.target.checked })} />
                <span className="sw-track" />
                Charts marked “Client sees it”
              </label>
            </div>
          </div>
          {confirmRegen ? (
            <div className="cu-confirm" role="alertdialog" aria-label="Confirm new link">
              <span>The current link stops working at once; anyone who had it needs the new one.</span>
              <button type="button" className="btn" onClick={() => setConfirmRegen(false)}>
                Keep it
              </button>
              <button type="button" className="btn btn-danger" onClick={() => link.mutate({ enabled: true, regenerate: true })}>
                Make a new link
              </button>
            </div>
          ) : (
            <div className="cu-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmRegen(true)}>
                <Icon name="refresh" size={14} /> Make a new link
              </button>
            </div>
          )}
        </>
      )}
      {!tracker.share.enabled && (
        <p className="hint">
          Off. Turn it on to get a link you can paste to the client or include in the email. It shows only the columns
          and charts marked “Client sees it”, always up to date.
        </p>
      )}
      {note && (
        <p className={note.tone === 'ok' ? 'hint cu-ok' : 'modal-error'} role={note.tone === 'ok' ? 'status' : 'alert'}>
          {note.text}
        </p>
      )}
    </div>
  );
}

// ── History ──────────────────────────────────────────────────────────────────

function HistoryTab({ tracker }: { tracker: ClientUpdate }) {
  const q = useQuery({
    queryKey: ['cu-deliveries', tracker.id],
    queryFn: () => listClientUpdateDeliveries(tracker.id),
    retry: 0,
  });
  const items = q.data?.items ?? [];
  return (
    <div className="cu-tab">
      <div className="table-wrap">
        <table className="ct cu-history">
          <thead>
            <tr>
              <th>When</th>
              <th>How</th>
              <th>To</th>
              <th className="num">Work orders</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && (
              <tr className="ct-empty">
                <td colSpan={5}>Loading…</td>
              </tr>
            )}
            {!q.isLoading && items.length === 0 && (
              <tr className="ct-empty">
                <td colSpan={5}>Nothing sent yet.</td>
              </tr>
            )}
            {items.map((d) => (
              <tr key={d.id}>
                <td>{whenCT(d.created_at)}</td>
                <td>
                  {d.trigger === 'scheduled' ? 'Scheduled' : d.trigger === 'test' ? 'Test' : 'Sent now'}
                  {d.sent_by && d.trigger !== 'scheduled' ? <small className="cu-sub"> by {d.sent_by.display_name}</small> : null}
                </td>
                <td className="cu-to">
                  {[...d.to, ...d.cc].join(', ') || '—'}
                  <small className="cu-sub">{d.subject}</small>
                </td>
                <td className="num">{d.row_count}</td>
                <td>
                  {d.status === 'sent' ? (
                    <span className="chip chip-sm chip-ok">Sent</span>
                  ) : (
                    <span className="chip chip-sm chip-danger" title={d.error ?? undefined}>
                      Failed
                    </span>
                  )}
                  {d.error && <small className="cu-sub cu-err">{d.error}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
