import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StatusGroup, StatusRef } from '@theone/shared';
import type { StatusWithPhase } from '../api/client';
import { getStatuses, patchStatus } from '../api/client';
import { useInvalidateObligations } from '../hooks/useObligations';
import { StatusPill, pillStyle } from './StatusPill';

const GROUP_ORDER: StatusGroup[] = ['open', 'active', 'done', 'closed'];
const GROUP_LABEL: Record<StatusGroup, string> = {
  open: 'Open',
  active: 'Active',
  done: 'Done',
  closed: 'Closed',
};

interface StatusChangeMenuProps {
  woId: string;
  current: StatusRef;
  /** Replace the default pill trigger (the detail header uses a button). */
  renderTrigger?: (api: { open: boolean; toggle: () => void }) => ReactNode;
  /** Anchor the popover to the right edge — for triggers near the viewport edge. */
  align?: 'left' | 'right';
}

/** Click the trigger → dropdown of all statuses (grouped) → PATCH → invalidate. */
export function StatusChangeMenu({ woId, current, renderTrigger, align = 'left' }: StatusChangeMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const invalidateObligations = useInvalidateObligations();

  const statusesQuery = useQuery({
    queryKey: ['statuses'],
    queryFn: getStatuses,
    staleTime: 5 * 60 * 1000,
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: (status_id: string) => patchStatus(woId, status_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['work-orders'] });
      qc.invalidateQueries({ queryKey: ['kpis'] });
      // A status change writes an activity row → the detail feed + audit tab
      // must re-read (S2 contract item 1).
      qc.invalidateQueries({ queryKey: ['wo-feed'] });
      qc.invalidateQueries({ queryKey: ['wo-activity'] });
      // S5: a status change is the single biggest silencer in the rule set
      // (schedule_owed, approval_followup, sla_blown all watch it). Re-read the
      // engine so the clocks agree with the board within the same click.
      invalidateObligations();
      setOpen(false);
    },
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const grouped = groupStatuses(statusesQuery.data ?? []);

  return (
    <div className="status-menu" ref={rootRef}>
      {renderTrigger ? (
        renderTrigger({ open, toggle: () => setOpen((v) => !v) })
      ) : (
        <StatusPill
          status={current}
          onClick={() => setOpen((v) => !v)}
          trailing={<span className="pill-caret" aria-hidden="true">▾</span>}
        />
      )}
      {open && (
        <div className={`status-menu-pop${align === 'right' ? ' is-right' : ''}`} role="menu">
          {statusesQuery.isLoading && <div className="status-menu-note">Loading…</div>}
          {statusesQuery.isError && <div className="status-menu-note">Failed to load statuses</div>}
          {mutation.isError && <div className="status-menu-note err">Update failed</div>}
          {GROUP_ORDER.map((g) =>
            grouped[g].length ? (
              <div className="status-menu-group" key={g}>
                <div className="status-menu-group-label">{GROUP_LABEL[g]}</div>
                {grouped[g].map((s) => {
                  const active = s.id === current.id;
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      key={s.id}
                      className={`status-menu-item${active ? ' is-current' : ''}`}
                      style={pillStyle(s.color)}
                      disabled={mutation.isPending}
                      onClick={() => {
                        if (active) {
                          setOpen(false);
                          return;
                        }
                        mutation.mutate(s.id);
                      }}
                    >
                      <span className="status-menu-dot" aria-hidden="true" />
                      <span className="status-menu-name">{s.name}</span>
                      {active && <span className="status-menu-check" aria-hidden="true">✓</span>}
                    </button>
                  );
                })}
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

function groupStatuses(statuses: StatusWithPhase[]): Record<StatusGroup, StatusWithPhase[]> {
  const out: Record<StatusGroup, StatusWithPhase[]> = { open: [], active: [], done: [], closed: [] };
  for (const s of [...statuses].sort((a, b) => a.position - b.position)) {
    out[s.group].push(s);
  }
  return out;
}
