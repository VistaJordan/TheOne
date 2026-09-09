import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STATUS_PERM_KEY, type StatusRef } from '@theone/shared';
import { ApiRequestError, getStatuses, patchStatus, requestStatusChange } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { useInvalidateObligations } from '../hooks/useObligations';
import { bucketStatuses, useStatusGroups } from '../lib/statusGroups';
import { StatusCircle } from './StatusCircle';
import { StatusPill } from './StatusPill';

/** The panel stops ~5 cm (≈190 px at 96 dpi) above the bottom of the viewport. */
const BOTTOM_GAP_PX = 190;
const MIN_HEIGHT_PX = 240;

/**
 * What the viewer may do with the status (0025, rule 2.4.1):
 *   direct   work_orders/status:edit    — the pick moves it
 *   request  work_orders/status:create  — the pick asks a manager
 *   none     neither                    — no menu at all
 */
export type StatusMenuMode = 'direct' | 'request' | 'none';

export function useStatusMenuMode(): StatusMenuMode {
  const { can } = useAuth();
  if (can(STATUS_PERM_KEY, 'edit')) return 'direct';
  if (can(STATUS_PERM_KEY, 'create')) return 'request';
  return 'none';
}

interface StatusChangeMenuProps {
  woId: string;
  current: StatusRef;
  /** Replace the default pill trigger (the detail header uses a button). The
      mode is handed over so the trigger can read "Request status change". */
  renderTrigger?: (api: { open: boolean; toggle: () => void; mode: StatusMenuMode }) => ReactNode;
  /** Anchor the popover to the right edge — for triggers near the viewport edge. */
  align?: 'left' | 'right';
}

/** Click the trigger → dropdown of all statuses (grouped) → PATCH (or, for a
    dispatcher, POST a request) → invalidate. */
export function StatusChangeMenu({ woId, current, renderTrigger, align = 'left' }: StatusChangeMenuProps) {
  const mode = useStatusMenuMode();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const invalidateObligations = useInvalidateObligations();

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const statusesQuery = useQuery({
    queryKey: ['statuses'],
    queryFn: getStatuses,
    staleTime: 5 * 60 * 1000,
    enabled: open,
  });
  const { groups } = useStatusGroups(open);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['work-orders'] });
    qc.invalidateQueries({ queryKey: ['kpis'] });
    // A status change writes an activity row → the detail feed + audit tab
    // must re-read (S2 contract item 1).
    qc.invalidateQueries({ queryKey: ['wo-feed'] });
    qc.invalidateQueries({ queryKey: ['wo-activity'] });
    qc.invalidateQueries({ queryKey: ['approvals'] });
    qc.invalidateQueries({ queryKey: ['approval-counts'] });
    qc.invalidateQueries({ queryKey: ['wo-approvals'] });
    // S5: a status change is the single biggest silencer in the rule set
    // (schedule_owed, approval_followup, sla_blown all watch it). Re-read the
    // engine so the clocks agree with the board within the same click.
    invalidateObligations();
  };

  const mutation = useMutation({
    mutationFn: async (s: { id: string; name: string }) => {
      if (mode === 'request') {
        await requestStatusChange(woId, s.id);
        return s.name;
      }
      await patchStatus(woId, s.id);
      return null;
    },
    onSuccess: (askedFor) => {
      invalidate();
      if (askedFor) {
        // Say so before closing — the header chip carries it from here.
        setSent(askedFor);
        window.setTimeout(() => {
          setSent(null);
          setOpen(false);
        }, 900);
        return;
      }
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

  // Size the panel to reach BOTTOM_GAP_PX above the viewport's bottom edge —
  // measured, because the trigger scrolls with the page.
  useLayoutEffect(() => {
    if (!open) return;
    const el = popRef.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top;
      el.style.maxHeight = `${Math.max(MIN_HEIGHT_PX, window.innerHeight - top - BOTTOM_GAP_PX)}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open]);

  // No grant at all: the pill is read-only. A verb the viewer cannot use is
  // not drawn here because the pill IS the value — there is nothing to lock.
  if (mode === 'none') {
    return renderTrigger ? null : <StatusPill status={current} />;
  }

  // Fractions are computed on the FULL group first, so a filtered list keeps
  // each status's own circle rather than re-spreading the wedges.
  const q = search.trim().toLowerCase();
  const buckets = bucketStatuses(statusesQuery.data ?? [], groups)
    .map((b) => ({ ...b, statuses: b.statuses.filter((s) => !q || s.name.toLowerCase().includes(q)) }))
    .filter((b) => b.statuses.length > 0);
  const noMatch = q.length > 0 && buckets.length === 0 && !statusesQuery.isLoading;
  const failText =
    mutation.error instanceof ApiRequestError
      ? mutation.error.message
      : mode === 'request'
        ? 'The request could not be sent'
        : 'Update failed';

  return (
    <div className="status-menu" ref={rootRef}>
      {renderTrigger ? (
        renderTrigger({ open, toggle: () => setOpen((v) => !v), mode })
      ) : (
        <StatusPill
          status={current}
          onClick={() => setOpen((v) => !v)}
          trailing={<span className="pill-caret" aria-hidden="true">▾</span>}
        />
      )}
      {open && (
        <div
          className={`status-menu-pop${align === 'right' ? ' is-right' : ''}`}
          role="menu"
          ref={popRef}
        >
          <input
            className="status-menu-search"
            type="search"
            placeholder={mode === 'request' ? 'Request a status…' : 'Search statuses…'}
            aria-label="Search statuses"
            value={search}
            autoFocus
            onChange={(e) => setSearch(e.target.value)}
          />
          {statusesQuery.isLoading && <div className="status-menu-note">Loading…</div>}
          {statusesQuery.isError && <div className="status-menu-note">Failed to load statuses</div>}
          {mutation.isError && <div className="status-menu-note err">{failText}</div>}
          {sent && <div className="status-menu-note ok">Request for {sent} sent for approval</div>}
          {noMatch && <div className="status-menu-note">No status matches “{search.trim()}”</div>}
          {/* data-oknob-own: keep the app-wide O-knob manager (lib/oknob.ts)
              from mounting a rail here — this menu scrolls bare, no bar. */}
          <div className="status-menu-scroll" data-oknob-own="">
            {buckets.map((b) => (
              <div className="status-menu-group" key={b.code}>
                <div className="status-menu-group-label">{b.label}</div>
                {b.statuses.map((s) => {
                  const active = s.id === current.id;
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      key={s.id}
                      className={`status-menu-item${active ? ' is-current' : ''}`}
                      disabled={mutation.isPending || sent !== null}
                      onClick={() => {
                        if (active) {
                          setOpen(false);
                          return;
                        }
                        mutation.mutate({ id: s.id, name: s.name });
                      }}
                    >
                      <StatusCircle group={b.code} color={s.color} fraction={s.fraction} size={16} />
                      <span className="status-menu-name">{s.name}</span>
                      {active && <span className="status-menu-check" aria-hidden="true">✓</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
