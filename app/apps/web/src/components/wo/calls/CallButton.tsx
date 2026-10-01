/* 0054 · The Call button on a work order, and the dialog behind it.
 *
 * Quo's API cannot start a call, so the dialog records the call first (who,
 * which number, just a call or a call to draft a quote from) and then opens
 * the number in the Quo app with a tel: link. Quo's webhook brings the
 * transcript back to that record; with "Call and draft a quote" the call log
 * offers the AI draft as soon as it lands. */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CALL_PERM_KEY,
  VISIT_MIRROR_KEYS,
  WO_CALL_CONTACT_LABELS,
  normalizePhone,
} from '@theone/shared';
import type { WoCallContactRole, WoCallPurpose } from '@theone/shared';
import type { WorkOrderDetailV2 } from '../../../api/client';
import { ApiRequestError, getWorkOrderMessages, placeWoCall } from '../../../api/client';
import { useAuth } from '../../../auth/AuthProvider';
import { str } from '../../../lib/fields';
import { Icon } from '../../Icon';

interface Contact {
  key: string;
  name: string;
  phone: string;
  role: WoCallContactRole;
  source: string;
}

export function CallButton({ wo }: { wo: WorkOrderDetailV2 }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  if (!can(CALL_PERM_KEY, 'create')) return null;
  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={() => setOpen(true)}
        title="Call the technician, vendor or client through Quo — optionally draft a quote from the call"
      >
        <Icon name="phone" size={14} />
        Call
      </button>
      {open && <CallDialog wo={wo} onClose={() => setOpen(false)} />}
    </>
  );
}

/** `preset` (0057): the technician map opens the dialog on the person whose
    Call button was pressed; the work order's own contacts stay as alternatives. */
export function CallDialog({ wo, onClose, preset }: {
  wo: WorkOrderDetailV2;
  onClose: () => void;
  preset?: { name: string; phone: string; role: WoCallContactRole };
}) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const canQuote = can('quotes', 'edit');

  // The vendor on the Quo line, when the Messages query already knows one.
  // Same key as the detail page, so this is usually a cache hit.
  const messages = useQuery({
    queryKey: ['wo-messages', wo.id],
    queryFn: () => getWorkOrderMessages(wo.id),
    retry: false,
    staleTime: 60_000,
  });

  const contacts = useMemo<Contact[]>(() => {
    const out: Contact[] = [];
    const presetPhone = preset ? normalizePhone(preset.phone) : null;
    if (preset && presetPhone) {
      out.push({ key: 'preset', name: preset.name, phone: presetPhone, role: preset.role, source: 'From the map' });
    }
    const fields = wo.fields ?? {};
    const techName = str(fields[VISIT_MIRROR_KEYS.techName]);
    const techPhone = normalizePhone(str(fields[VISIT_MIRROR_KEYS.techPhone]));
    if (techPhone && techPhone !== presetPhone) {
      out.push({ key: 'tech', name: techName ?? 'Technician', phone: techPhone, role: 'tech', source: 'Latest visit' });
    }
    const vendor = messages.data?.quo.conversation?.vendor;
    const vendorPhone = normalizePhone(vendor?.phone);
    if (vendor && vendorPhone && vendorPhone !== techPhone && vendorPhone !== presetPhone) {
      out.push({ key: 'vendor', name: vendor.name, phone: vendorPhone, role: 'vendor', source: 'Quo line' });
    }
    return out;
  }, [wo.fields, messages.data, preset]);

  const [pick, setPick] = useState<string>('');
  const chosen = contacts.find((c) => c.key === pick) ?? null;
  const usingOther = pick === 'other' || (pick === '' && contacts.length === 0);
  const selected = usingOther ? null : (chosen ?? contacts[0] ?? null);

  const [otherName, setOtherName] = useState('');
  const [otherPhone, setOtherPhone] = useState('');
  const [otherRole, setOtherRole] = useState<WoCallContactRole>('client');
  const [purpose, setPurpose] = useState<WoCallPurpose>('call');

  const phone = usingOther ? normalizePhone(otherPhone) : (selected?.phone ?? null);
  const name = usingOther ? otherName.trim() || null : (selected?.name ?? null);
  const role = usingOther ? otherRole : (selected?.role ?? 'other');

  const [placed, setPlaced] = useState<{ dial: string; name: string | null } | null>(null);
  const mutation = useMutation({
    mutationFn: () => placeWoCall(wo.id, { phone: phone!, contact_name: name, contact_role: role, purpose }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['wo-calls', wo.id] });
      setPlaced({ dial: res.dial, name });
      // Hand the number to the Quo app (it is the Windows tel: handler).
      window.location.href = res.dial;
    },
  });

  const activeKey = usingOther ? 'other' : (selected?.key ?? '');
  const callsHref = `/work-orders/${encodeURIComponent(wo.wo_number)}?tab=messages`;

  return (
    <div
      className="scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="callT"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="sheet call-sheet">
        <h2 className="sheet-t" id="callT">
          <Icon name="phone" size={18} />
          {placed ? 'Calling in Quo' : `Call from ${wo.wo_number}`}
        </h2>

        {placed ? (
          <>
            <p className="sheet-b">
              Quo should be dialling <b>{placed.name ?? placed.dial.replace('tel:', '')}</b> now. When
              the call ends, Quo sends the transcript to this work order
              {purpose === 'quote' ? ' and the AI quote draft is one click away in the call log.' : '.'}
            </p>
            <p className="call-hint">
              <Icon name="info" size={12} />
              Quo did not open? Dial <span className="mono">{placed.dial.replace('tel:', '')}</span> from
              the Quo app within 30 minutes — the call still lands here. You can also paste a transcript
              onto the call by hand.
            </p>
            <div className="sheet-f">
              <Link className="btn" to={callsHref} onClick={onClose}>
                <Icon name="list" size={14} />
                Open the call log
              </Link>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="sheet-b">
              Opens the number in the Quo app and records the call on this work order.
            </p>

            <div className="call-field">
              <span className="overline">Who</span>
              <div className="call-contacts" role="radiogroup" aria-label="Who to call">
                {contacts.map((c) => (
                  <label key={c.key} className={`call-contact${activeKey === c.key ? ' is-on' : ''}`}>
                    <input
                      type="radio"
                      name="call-who"
                      checked={activeKey === c.key}
                      onChange={() => setPick(c.key)}
                    />
                    <span className="call-contact-main">
                      <b>{c.name}</b>
                      <span className="mono">{c.phone}</span>
                    </span>
                    <span className="chip chip-sm">{WO_CALL_CONTACT_LABELS[c.role]}</span>
                    <span className="call-contact-src">{c.source}</span>
                  </label>
                ))}
                <label className={`call-contact${activeKey === 'other' ? ' is-on' : ''}`}>
                  <input
                    type="radio"
                    name="call-who"
                    checked={activeKey === 'other'}
                    onChange={() => setPick('other')}
                  />
                  <span className="call-contact-main">
                    <b>Another number</b>
                    <span>{contacts.length === 0 ? 'No technician phone on this work order yet' : 'Client, vendor, anyone'}</span>
                  </span>
                </label>
              </div>
            </div>

            {usingOther && (
              <div className="call-other">
                <div className="field">
                  <label className="lbl" htmlFor="call-name">Name</label>
                  <input className="fld" id="call-name" value={otherName} maxLength={200} onChange={(e) => setOtherName(e.target.value)} />
                </div>
                <div className="field">
                  <label className="lbl" htmlFor="call-phone">Phone</label>
                  <input
                    className={`fld mono${otherPhone.trim() !== '' && !normalizePhone(otherPhone) ? ' is-err' : ''}`}
                    id="call-phone"
                    type="tel"
                    value={otherPhone}
                    maxLength={40}
                    placeholder="(409) 555-0143"
                    onChange={(e) => setOtherPhone(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="lbl" htmlFor="call-role">They are the</label>
                  <select className="fld" id="call-role" value={otherRole} onChange={(e) => setOtherRole(e.target.value as WoCallContactRole)}>
                    {(Object.keys(WO_CALL_CONTACT_LABELS) as WoCallContactRole[]).map((r) => (
                      <option key={r} value={r}>{WO_CALL_CONTACT_LABELS[r]}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="call-field">
              <span className="overline">After the call</span>
              <div className="seg" role="group" aria-label="After the call">
                <button
                  type="button"
                  className={`seg-btn${purpose === 'call' ? ' is-on' : ''}`}
                  aria-pressed={purpose === 'call'}
                  onClick={() => setPurpose('call')}
                >
                  Just call
                </button>
                <button
                  type="button"
                  className={`seg-btn${purpose === 'quote' ? ' is-on' : ''}`}
                  aria-pressed={purpose === 'quote'}
                  aria-disabled={canQuote ? undefined : true}
                  title={canQuote ? undefined : 'Drafting a quote needs the Quotes edit permission'}
                  onClick={() => canQuote && setPurpose('quote')}
                >
                  <Icon name="zap" size={12} />
                  Call and draft a quote
                </button>
              </div>
              <span className="hint">
                {purpose === 'quote'
                  ? 'When Quo sends the transcript, the AI drafts the quote from the call. You review and adjust it, then Submit quote fills this work order’s quote.'
                  : 'The call and its transcript are kept on this work order. You can still draft a quote from it later.'}
              </span>
            </div>

            {mutation.isError && (
              <p className="snooze-err" role="alert">
                <Icon name="alert-circle" size={12} />
                {mutation.error instanceof ApiRequestError ? mutation.error.message : 'Could not record the call.'}
              </p>
            )}

            <div className="sheet-f">
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!phone || mutation.isPending}
                title={!phone ? 'Pick who to call, or type a number' : undefined}
                onClick={() => mutation.mutate()}
              >
                <Icon name="phone-out" size={14} />
                {mutation.isPending ? 'Recording…' : 'Call via Quo'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
