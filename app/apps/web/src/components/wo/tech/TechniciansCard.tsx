/* 0057 · The work order's technicians (People tab): who has been hired onto
   it, and the way into the technician map. Hiring happens on the map; a visit
   then picks from this list (or searches anyone). */

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WoTechnician } from '@theone/shared';
import type { WorkOrderDetailV2 } from '../../../api/client';
import { ApiRequestError, getWoTechnicians, releaseWoTechnician } from '../../../api/client';
import { feedTime, initials } from '../../../lib/fields';
import { Icon } from '../../Icon';
import { CallDialog } from '../calls/CallButton';
import { TechMapSheet } from './TechMapSheet';

export function TechniciansCard({ wo }: { wo: WorkOrderDetailV2 }) {
  const qc = useQueryClient();
  const [mapOpen, setMapOpen] = useState(false);
  const [calling, setCalling] = useState<WoTechnician | null>(null);
  const key = ['wo-technicians', wo.id];
  const query = useQuery({ queryKey: key, queryFn: () => getWoTechnicians(wo.id) });

  const release = useMutation({
    mutationFn: (t: WoTechnician) => releaseWoTechnician(wo.id, t.vendor.id),
    onSuccess: (res) => qc.setQueryData(key, res),
  });

  const all = query.data?.technicians ?? [];
  const current = all.filter((t) => t.released_at === null);
  const past = all.filter((t) => t.released_at !== null);
  const can = query.data?.can;

  return (
    <section className="card card-techs">
      <div className="card-head">
        <h2 className="card-title grow">Technicians</h2>
        <span className="card-meta">{current.length === 0 ? 'Nobody hired yet' : `${current.length} hired`}</span>
        {can?.open_map && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setMapOpen(true)}>
            <Icon name="pin" size={14} />
            Find a technician
          </button>
        )}
      </div>

      {query.isError && <div className="empty-flat">Could not load the technicians on this work order.</div>}
      {!query.isError && !query.isLoading && all.length === 0 && (
        <div className="empty-flat">
          {can?.open_map
            ? 'Open the map to see who is near this work order, call them, and hire one — they are listed here once hired.'
            : 'Nobody has been hired onto this work order yet.'}
        </div>
      )}

      {current.length > 0 && (
        <ul className="techs">
          {current.map((t) => (
            <li className="tech" key={t.id}>
              <span className="avatar" aria-hidden="true">{initials(t.vendor.name)}</span>
              <span className="tech-main">
                <span className="p-name">
                  {t.vendor.name}
                  {t.vendor.blacklisted && <span className="chip chip-danger chip-sm">Blacklisted</span>}
                </span>
                <span className="p-role">
                  {[t.vendor.primary_trade, [t.vendor.city, t.vendor.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') ||
                    (t.vendor.kind === 'tech' ? 'Technician' : 'VR vendor')}
                </span>
                <span className="tech-meta">
                  Hired by {t.hired_by?.name ?? 'someone'} · {feedTime(t.hired_at)}
                </span>
                {t.compliance_warning && (
                  <span className="tech-warn"><Icon name="alert" size={12} />{t.compliance_warning}</span>
                )}
              </span>
              <span className="tech-actions">
                {t.vendor.phone && (
                  <button type="button" className="btn btn-sm is-ghost" onClick={() => setCalling(t)} title="Call through Quo — the call is recorded on this work order">
                    <Icon name="phone" size={12} />
                    <span className="mono">{t.vendor.phone}</span>
                  </button>
                )}
                {can?.hire && (
                  <button
                    type="button"
                    className="btn btn-sm is-ghost"
                    disabled={release.isPending}
                    onClick={() => release.mutate(t)}
                    title="Take this technician off the work order — the record and its visits stay"
                  >
                    <Icon name="x" size={12} />
                    Take off
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {release.isError && (
        <div className="callout" style={{ margin: '0 14px 12px' }}>
          <Icon name="alert" size={14} />
          <span>{release.error instanceof ApiRequestError ? release.error.message : 'Could not take the technician off.'}</span>
        </div>
      )}

      {past.length > 0 && (
        <p className="tech-past">
          Earlier on this work order: {past.map((t) => t.vendor.name).join(', ')}
        </p>
      )}

      {/* Portalled: a fixed overlay inside the tab panel is clipped to it. */}
      {mapOpen && createPortal(<TechMapSheet wo={wo} onClose={() => setMapOpen(false)} />, document.body)}
      {calling && calling.vendor.phone && createPortal(
        <CallDialog
          wo={wo}
          onClose={() => setCalling(null)}
          preset={{ name: calling.vendor.name, phone: calling.vendor.phone, role: calling.vendor.kind === 'tech' ? 'tech' : 'vendor' }}
        />,
        document.body,
      )}
    </section>
  );
}
