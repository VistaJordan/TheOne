import type { ObligationSummary, Phase, WorkOrderDetailV2 } from '../../api/client';
import { DASH, FIELD, dateVal, daysSince, field, numericDate } from '../../lib/fields';
import { deriveHeaderMeta } from '../../lib/woDerive';
import { CopyButton } from '../CopyButton';
import { Icon } from '../Icon';
import { ClockChipCluster } from '../obligations/ClockChip';
import { StatusChangeMenu } from '../StatusChangeMenu';
import { StatusPill } from '../StatusPill';
import { PhaseBar } from './PhaseBar';

/** Age past which the aging cluster flips to the warn ramp. */
const AGE_WARN_DAYS = 10;

interface WoHeaderProps {
  wo: WorkOrderDetailV2;
  phase: Phase | null;
  /** Days the WO has sat in its current status, from the newest status change. */
  inStatusDays: number | null;
  /** S5 — open obligations on this WO, rendered as clocks beside the aging cells. */
  obligations?: ObligationSummary[];
  /** Clicking a clock chip scrolls the rail's Obligations card into view. */
  onClockClick?: () => void;
}

export function WoHeader({ wo, phase, inStatusDays, obligations, onClockClick }: WoHeaderProps) {
  const meta = deriveHeaderMeta(wo);
  const f = wo.fields ?? {};
  const age = daysSince(wo.date_received);
  const openPipeline = wo.status.group === 'open' || wo.status.group === 'active';
  const ageWarn = age != null && age >= AGE_WARN_DAYS && openPipeline;
  const sla = numericDate(dateVal(field(f, FIELD.slaDue)));

  return (
    <section className="card wohead">
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
        </div>
      </div>

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
              <Icon name="snow" size={12} />
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
    </section>
  );
}
