import { useRef, useState } from 'react';
import { ECOTRAK_STATUS_KEY, PARTS_REQUIRED_KEY, ecotrakStatusLabel } from '@theone/shared';
import type { ObligationSummary, Phase, WorkOrderDetailV2 } from '../../api/client';
import { DASH, FIELD, dateVal, daysSince, field, isCostOverNte, isEmergency, isEscalated, money, numericDate, str } from '../../lib/fields';
import { EmergencyBadge } from '../EmergencyBadge';
import { EscalatedBadge } from '../EscalatedBadge';
import { useCanEditField, useWoFieldSave } from './fieldEdit';
import { deriveHeaderMeta, resolveMoney } from '../../lib/woDerive';
import { tradeIcon } from '../../lib/tradeIcon';
import { CopyButton } from '../CopyButton';
import { Icon } from '../Icon';
import { ClockChipCluster } from '../obligations/ClockChip';
import { StatusChangeMenu } from '../StatusChangeMenu';
import { StatusPill } from '../StatusPill';
import { PhaseBar } from './PhaseBar';
import { StatusChangeBanner } from './StatusChangeBanner';
import { AcceptanceChip } from './AcceptanceChip';

/** One labelled amount in the worth block. The currency sign is drawn
    separately, smaller and lighter, so label + amount read the way the comp
    has them; an unset amount shows the dash alone. */
function WorthCell({ label, value }: { label: string; value: number | null | undefined }) {
  const set = value != null && Number.isFinite(value);
  return (
    <span className="worth-cell">
      <span className="worth-k">{label}</span>
      <span className={`worth-v${set ? '' : ' is-none'}`}>
        {set && <span className="worth-cur">$</span>}
        {set ? money(value).replace(/^\$/, '') : DASH}
      </span>
    </span>
  );
}

/** Age past which the aging cluster flips to the warn ramp. */
const AGE_WARN_DAYS = 10;

// Whether the header is folded down to its top row. A property of the browser,
// not the work order — someone on a small screen wants it folded on EVERY WO,
// so it lives in localStorage, not in navigation state.
const COLLAPSE_KEY = 'theone.wo.head.collapsed';

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveCollapsed(v: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
  } catch {
    /* storage disabled — the fold simply does not survive the reload */
  }
}

interface WoHeaderProps {
  wo: WorkOrderDetailV2;
  phase: Phase | null;
  /** Days the WO has sat in its current status, from the newest status change. */
  inStatusDays: number | null;
  /** S5 — open obligations on this WO, rendered as clocks beside the aging cells. */
  obligations?: ObligationSummary[];
  /** Clicking a clock chip scrolls the rail's Obligations card into view. */
  onClockClick?: () => void;
  /** Rule 11.2.1: whether the quote carries data (false = missing or empty,
      null/undefined = not known here), so the status menu can tag Quote Ready. */
  quoteFilled?: boolean | null;
}

export function WoHeader({ wo, phase, inStatusDays, obligations, onClockClick, quoteFilled }: WoHeaderProps) {
  const meta = deriveHeaderMeta(wo);
  const f = wo.fields ?? {};
  // Rules 2.6.3 / 2.7: where the work order sits on Ecotrak (stamped by the
  // inbound sync); the status menu checks every pick against it.
  const ecotrakLabel = ecotrakStatusLabel(f[ECOTRAK_STATUS_KEY] as string | undefined);
  const age = daysSince(wo.date_received);
  const openPipeline = wo.status.group === 'open' || wo.status.group === 'active';
  const ageWarn = age != null && age >= AGE_WARN_DAYS && openPipeline;
  const sla = numericDate(dateVal(field(f, FIELD.slaDue)));
  // 'Assignee' is the field the list filters on; the older free-text
  // 'Assignee Name TXT' backstops work orders imported before it existed.
  const assignee = str(field(f, FIELD.assignee)) ?? str(field(f, FIELD.assigneeName));
  // Same money rule as the Finances card and the list column: the cost turns
  // the whole block red once it passes the NTE.
  const m = resolveMoney(wo);
  const overNte = isCostOverNte(m.cost, m.nte);
  // Rule 2.5.1: the Emergency flag reads red here as in every other view.
  const emergency = isEmergency(f);
  // Rules 7.3.1 / 7.3.3: the Escalated flag reads amber here and everywhere.
  // Mark as Escalated is a manager's button: the field's own edit permission
  // decides who sees it (0038 locks the dispatcher tiers out).
  const escalated = isEscalated(f);
  const escalatedKey = `fields.${FIELD.escalated}`;
  const canEscalate = useCanEditField(escalatedKey);
  const escalateSave = useWoFieldSave(wo.id);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  // "Request again" on a rejected request re-opens the status menu.
  const statusTriggerRef = useRef<HTMLButtonElement>(null);
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      saveCollapsed(!v);
      return !v;
    });
  };

  // Who has it and what it is worth: the two things asked about a WO before
  // anything else. Expanded they sit with the other meta chips; folded they
  // move up beside the status so the fold never hides them.
  const whoAndWorth = (
    <>
      <span
        className={`chip${assignee ? '' : ' chip-outline'}`}
        title={assignee ? 'Assignee — the dispatcher handling this work order' : 'No assignee yet'}
      >
        <Icon name="user" size={12} />
        {assignee ?? 'Unassigned'}
      </span>
      <span
        className={`worth${overNte ? ' is-over' : ''}`}
        title={
          overNte
            ? `Cost ${money(m.cost)} is over the client NTE of ${money(m.nte)}`
            : 'Client NTE (not to exceed) and the cost so far'
        }
      >
        <WorthCell label="Client NTE" value={m.nte} />
        <WorthCell label="Cost" value={m.cost} />
      </span>
    </>
  );

  return (
    <section className={`card wohead${collapsed ? ' is-collapsed' : ''}${emergency ? ' is-emergency' : ''}${escalated ? ' is-escalated' : ''}`}>
      <div className="wohead-top">
        <div className="wohead-idline">
          <h1 className="wo-title">{wo.wo_number}</h1>
          <CopyButton value={wo.wo_number} label="Copy WO number" />
          {emergency && <EmergencyBadge />}
          {escalated && <EscalatedBadge />}
          {wo.ext_name && (
            <span className="extref">
              <span className="extref-k">Ext ref</span>
              <span className="extref-v">{wo.ext_name}</span>
              <CopyButton value={wo.ext_name} label="Copy external reference" size={12} />
            </span>
          )}
        </div>
        <div className="wohead-actions">
          {collapsed && whoAndWorth}
          <StatusPill
            status={wo.status}
            className="pill-lg"
            leading={<span className="pill-dot" aria-hidden="true" />}
          />
          {wo.acceptance && <AcceptanceChip state={wo.acceptance} />}
          {wo.status_change && (
            <StatusChangeBanner
              state={wo.status_change}
              onRequestAgain={() => statusTriggerRef.current?.click()}
            />
          )}
          <StatusChangeMenu
            woId={wo.id}
            current={wo.status}
            align="right"
            ecotrakStatus={f[ECOTRAK_STATUS_KEY]}
            gateHints={{ quoteFilled: quoteFilled ?? null, partsValue: f[PARTS_REQUIRED_KEY] ?? null }}
            renderTrigger={({ open, toggle, mode }) => (
              <button
                type="button"
                ref={statusTriggerRef}
                className="btn btn-primary"
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
                title={
                  mode === 'request'
                    ? 'Asks a manager to move the status — it changes when they approve (rule 2.4.1)'
                    : undefined
                }
              >
                <Icon name={mode === 'request' ? 'send' : 'swap'} size={14} />
                {mode === 'request' ? 'Request status change' : 'Change status'}
              </button>
            )}
          />
          {canEscalate && (
            <button
              type="button"
              className={`btn${escalated ? ' is-escalated' : ''}`}
              disabled={escalateSave.isPending}
              aria-pressed={escalated}
              onClick={() => escalateSave.mutate({ key: escalatedKey, value: !escalated })}
              title={
                escalated
                  ? 'Clear the escalation — it leaves the Escalation Tracker and the top of the inbox (rule 7.3.1)'
                  : 'Flag this work order as escalated: amber in every view, pinned to the top of the inbox, on the Escalation Tracker (rule 7.3.1)'
              }
            >
              <Icon name="alert-circle" size={14} />
              {escalated ? 'Escalated · Clear' : 'Mark as Escalated'}
            </button>
          )}
          <button
            type="button"
            className="icon-btn wohead-fold"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            title={collapsed ? 'Show the full header' : 'Fold the header to one row'}
            aria-label={collapsed ? 'Show the full header' : 'Fold the header to one row'}
          >
            <Icon name="chev-d" size={14} />
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
      <div className="wohead-mid">
        <div className="wohead-meta">
          <span className="wohead-client">{meta.client}</span>
          {meta.store && (
            <>
              <span className="sep-dot">·</span>
              <span>{meta.store}</span>
            </>
          )}
          {meta.location && (
            <>
              <span className="sep-dot">·</span>
              <span>{meta.location}</span>
            </>
          )}
          {meta.trade && (
            <span className="chip">
              <Icon name={tradeIcon(meta.trade)} size={12} />
              {meta.trade}
            </span>
          )}
          {meta.billingEntity && <span className="chip chip-accent">{meta.billingEntity}</span>}
          {ecotrakLabel && (
            <span
              className="chip chip-ecotrak"
              title="Where this work order sits on Ecotrak, as of the last sync (rules 2.6.3 / 2.7 check status changes against it)"
            >
              Ecotrak · {ecotrakLabel}
            </span>
          )}
          {meta.priorityLabel && (
            <span className="chip chip-warn">
              <Icon name="flag" size={12} />
              {meta.priorityLabel}
            </span>
          )}
          {whoAndWorth}
        </div>

        <ClockChipCluster items={obligations ?? []} onSelect={onClockClick} />

        <div className="aging">
          <div className="aging-cell">
            <span className="aging-k">Age</span>
            <span className={`aging-v${ageWarn ? ' is-warn' : ''}${age == null ? ' is-none' : ''}`}>
              {ageWarn && <Icon name="alert" size={12} />}
              {age == null ? DASH : `${age}d`}
            </span>
          </div>
          <div className="aging-cell">
            <span className="aging-k">In status</span>
            <span className={`aging-v${inStatusDays == null ? ' is-none' : ''}`}>
              {inStatusDays == null ? DASH : `${inStatusDays}d`}
            </span>
          </div>
          <div className="aging-cell">
            <span className="aging-k">SLA due</span>
            <span className={`aging-v${sla ? '' : ' is-none'}`}>{sla ?? DASH}</span>
          </div>
        </div>
      </div>

      <PhaseBar current={phase} statusName={wo.status.name} />
        </>
      )}
    </section>
  );
}
