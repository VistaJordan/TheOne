import { useState } from 'react';
import type { Phase, WorkOrderDetailV2 } from '../../api/client';
import { DASH, FIELD, dateVal, daysSince, field, money, numericDate, str } from '../../lib/fields';
import { deriveHeaderMeta } from '../../lib/woDerive';
import { tradeIcon } from '../../lib/tradeIcon';
import { CopyButton } from '../CopyButton';
import { Icon } from '../Icon';
import { StatusChangeMenu } from '../StatusChangeMenu';
import { StatusPill } from '../StatusPill';
import { PhaseBar } from './PhaseBar';

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
}

export function WoHeader({ wo, phase, inStatusDays }: WoHeaderProps) {
  const meta = deriveHeaderMeta(wo);
  const f = wo.fields ?? {};
  const age = daysSince(wo.date_received);
  const openPipeline = wo.status.group === 'open' || wo.status.group === 'active';
  const ageWarn = age != null && age >= AGE_WARN_DAYS && openPipeline;
  const sla = numericDate(dateVal(field(f, FIELD.slaDue)));
  // 'Assignee' is the field the list filters on; the older free-text
  // 'Assignee Name TXT' backstops work orders imported before it existed.
  const assignee = str(field(f, FIELD.assignee)) ?? str(field(f, FIELD.assigneeName));
  const [collapsed, setCollapsed] = useState(loadCollapsed);
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
      <span className="chip" title="Client NTE — not to exceed">
        <Icon name="dollar" size={12} />
        {/* The dollar icon is this chip's label, so the amount drops money()'s own "$". */}
        {money(wo.nte).replace(/^\$/, '')}
      </span>
    </>
  );

  return (
    <section className={`card wohead${collapsed ? ' is-collapsed' : ''}`}>
      <div className="wohead-top">
        <div className="wohead-idline">
          <h1 className="wo-title">{wo.wo_number}</h1>
          <CopyButton value={wo.wo_number} label="Copy WO number" />
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
          <StatusChangeMenu
            woId={wo.id}
            current={wo.status}
            align="right"
            renderTrigger={({ open, toggle }) => (
              <button
                type="button"
                className="btn btn-primary"
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
              >
                <Icon name="swap" size={14} />
                Change status
              </button>
            )}
          />
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
          {meta.priorityLabel && (
            <span className="chip chip-warn">
              <Icon name="flag" size={12} />
              {meta.priorityLabel}
            </span>
          )}
          {whoAndWorth}
        </div>

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
