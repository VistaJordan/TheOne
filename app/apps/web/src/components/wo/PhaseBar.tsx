import type { Phase } from '../../api/client';
import { CONDITIONAL_PHASE, PHASE_ORDER } from '../../lib/phases';
import { Icon } from '../Icon';

interface PhaseBarProps {
  /** null → the WO sits outside the pipeline (Cancelled / Postponed): inert bar. */
  current: Phase | null;
  statusName: string;
}

/** The nine-stage pipeline strip from the comp. `Parts` is conditional: it
    renders as a dashed track + dashed "if parts" badge unless it IS the
    current phase, and is never marked complete. */
export function PhaseBar({ current, statusName }: PhaseBarProps) {
  const inert = current === null;
  const currentIndex = current ? PHASE_ORDER.indexOf(current) : -1;

  return (
    <>
      <ol
        className={`phasebar${inert ? ' is-inert' : ''}`}
        aria-label="Work order phase"
      >
        {PHASE_ORDER.map((phase, i) => {
          const isCurrent = !inert && i === currentIndex;
          const isConditional = phase === CONDITIONAL_PHASE && !isCurrent;
          const isDone = !inert && !isConditional && i < currentIndex;
          const cls = [
            'phase',
            isDone ? 'is-done' : '',
            isCurrent ? 'is-current' : '',
            isConditional ? 'is-cond' : '',
          ].filter(Boolean).join(' ');

          return (
            <li key={phase} className={cls} aria-current={isCurrent ? 'step' : undefined}>
              <span className="phase-track" />
              <span className="phase-lbl">
                {isConditional ? (
                  <>
                    <span className="phase-name">{phase}</span>
                    <span className="phase-if">if parts</span>
                  </>
                ) : (
                  <>
                    <span className="phase-mark">
                      {isDone && <Icon name="check" size={12} />}
                      {isCurrent && <span className="phase-pulse" />}
                    </span>
                    <span className="phase-name">{phase}</span>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {inert && (
        <div className="phase-note">
          <Icon name="alert" size={12} />
          <span>Pipeline inert — <b>{statusName}</b> sits outside the nine stages.</span>
        </div>
      )}
    </>
  );
}
