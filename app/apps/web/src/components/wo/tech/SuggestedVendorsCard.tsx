/* 0069 · Suggested vendors (People tab): the top few vendors for this work
   order's trade, location and client. The preferred vendors somebody picked
   come first; the rest is filled and ordered by the rules in Admin › Vendors
   & map. Hire is the map's own hire — same record, same paperwork warning.
   Shown to whoever may open the technician map. */

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SuggestedVendor } from '@theone/shared';
import type { WorkOrderDetailV2 } from '../../../api/client';
import { ApiRequestError, getWoSuggestedVendors, hireWoTechnician } from '../../../api/client';
import { useAuth } from '../../../auth/AuthProvider';
import { Icon } from '../../Icon';
import { CallDialog } from '../calls/CallButton';

/** Why a vendor is on the list, in the fewest words. */
function facts(v: SuggestedVendor, client: string | null): string {
  const out: string[] = [];
  if (v.distance_miles !== null) out.push(`${v.distance_miles} mi`);
  if (v.reach === 'statewide') out.push('Statewide');
  if (v.reach === 'nationwide') out.push('Nationwide');
  if (v.client_jobs > 0) out.push(`${v.client_jobs} past job${v.client_jobs === 1 ? '' : 's'} for ${client ?? 'this client'}`);
  if (v.work_orders_count > 0) out.push(`${v.work_orders_count} job${v.work_orders_count === 1 ? '' : 's'} with us`);
  if (v.regular_hourly_rate !== null) out.push(`$${v.regular_hourly_rate}/h`);
  return out.join(' · ');
}

export function SuggestedVendorsCard({ wo }: { wo: WorkOrderDetailV2 }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const allowed = can('vendor_map', 'view');
  const [calling, setCalling] = useState<SuggestedVendor | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const key = ['wo-suggested-vendors', wo.id];
  const query = useQuery({ queryKey: key, queryFn: () => getWoSuggestedVendors(wo.id), enabled: allowed, retry: 0 });

  const hire = useMutation({
    mutationFn: (v: SuggestedVendor) => hireWoTechnician(wo.id, v.id),
    onSuccess: (res, v) => {
      setNotice(res.warning ?? `${v.name} is hired onto this work order.`);
      qc.setQueryData(['wo-technicians', wo.id], { technicians: res.technicians, can: res.can });
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['wo-tech-map', wo.id] });
      void qc.invalidateQueries({ queryKey: ['activity'] });
    },
    onError: (e) => setNotice(e instanceof ApiRequestError ? e.message : 'Could not hire.'),
  });

  if (!allowed || query.isError) return null;
  const d = query.data;
  if (!d) return null;
  const head = d.work_order;
  const forWhat = [head.trade, [head.city, head.state].filter(Boolean).join(', '), head.client].filter(Boolean).join(' · ');

  return (
    <section className="card card-techs card-sugg">
      <div className="card-head">
        <h2 className="card-title grow">Suggested vendors</h2>
        {forWhat && <span className="card-meta">{forWhat}</span>}
      </div>

      {!d.placed && (
        <p className="tech-past">
          This work order has no ZIP or city we could place, so distance is unknown: only preferred, statewide and nationwide vendors can be suggested.
        </p>
      )}

      {d.vendors.length === 0 ? (
        <div className="empty-flat">
          {d.auto_fill
            ? 'No vendor on file matches this trade and location yet. Open the map to look wider.'
            : 'No preferred vendor is set for this client, trade and place.'}
        </div>
      ) : (
        <ul className="techs">
          {d.vendors.map((v) => (
            <li className="tech" key={v.id}>
              <span className="sugg-n mono" aria-hidden="true">{v.position}</span>
              <span className="tech-main">
                <span className="p-name">
                  <Link to={`/vendors/${v.id}`}>{v.name}</Link>
                  {v.preferred && (
                    <span className="chip chip-sm" title={v.preferred.note ?? `Preferred for ${v.preferred.rule}`}>
                      Preferred{v.preferred.rank > 1 ? ` #${v.preferred.rank}` : ''}
                    </span>
                  )}
                  {v.hired && <span className="chip chip-ok chip-sm">Hired</span>}
                </span>
                <span className="p-role">
                  {[v.primary_trade, [v.city, v.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') ||
                    (v.kind === 'tech' ? 'Technician' : 'VR vendor')}
                </span>
                <span className="tech-meta">
                  {[v.preferred ? `Preferred for ${v.preferred.rule}` : null, facts(v, head.client)].filter(Boolean).join(' · ') || 'Matches the trade and covers this location'}
                </span>
                {v.compliance_warning && (
                  <span className="tech-warn"><Icon name="alert" size={12} />{v.compliance_warning}</span>
                )}
              </span>
              <span className="tech-actions">
                {v.phone && (
                  <button type="button" className="btn btn-sm is-ghost" onClick={() => setCalling(v)} title="Call through Quo — the call is recorded on this work order">
                    <Icon name="phone" size={12} />
                    <span className="mono">{v.phone}</span>
                  </button>
                )}
                {d.can.hire && !v.hired && (
                  <button type="button" className="btn btn-sm" disabled={hire.isPending} onClick={() => hire.mutate(v)}>
                    <Icon name="user-plus" size={12} />
                    Hire
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {notice && (
        <div className="callout" style={{ margin: '0 14px 12px' }}>
          <Icon name="info" size={14} />
          <span>{notice}</span>
        </div>
      )}

      {calling && calling.phone && createPortal(
        <CallDialog
          wo={wo}
          onClose={() => setCalling(null)}
          preset={{ name: calling.name, phone: calling.phone, role: calling.kind === 'tech' ? 'tech' : 'vendor' }}
        />,
        document.body,
      )}
    </section>
  );
}
