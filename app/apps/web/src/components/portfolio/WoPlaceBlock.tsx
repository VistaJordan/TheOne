/* 0060 · The site and asset RECORDS behind a work order, shown under the Site
 * card's address. The address above it is still the work order's own text
 * field; this is the link to the portfolio — which site this is, which asset
 * the job is on — with what a dispatcher needs from them at a glance.
 *
 * Not linked yet: the sites that look like this work order's are offered, and
 * any site can be searched for. Linking is logged on the work order. */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getWoPlace, setWoPlace } from '../../api/client';
import { Icon } from '../Icon';
import { AssetStatusChip, ConditionChip, SitePicker, WarrantyChip, errText } from './PortfolioParts';

export function WoPlaceBlock({ woRef, woId }: { woRef: string; woId: string }) {
  const qc = useQueryClient();
  const key = ['wo-place', woRef];
  const q = useQuery({ queryKey: key, queryFn: () => getWoPlace(woRef), retry: 0 });
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = useMutation({
    mutationFn: (input: { site_id?: string | null; asset_id?: string | null }) => setWoPlace(woRef, input),
    onSuccess: (res) => {
      qc.setQueryData(key, res);
      setChanging(false);
      setError(null);
      // The link is a logged change on the work order.
      void qc.invalidateQueries({ queryKey: ['wo-activity', woId] });
      void qc.invalidateQueries({ queryKey: ['sites-meta'] });
    },
    onError: (e) => setError(errText(e, 'Could not link the work order.')),
  });

  const p = q.data;
  // A role without Sites sees the card exactly as it was before 0060.
  if (!p || (!p.can.view_sites && !p.site)) return null;
  const site = p.site;

  return (
    <div className="pf-place">
      <div className="pf-place-head">
        <span className="overline">Site record</span>
        {site && p.can.link && !changing && (
          <span>
            <button type="button" className="link-btn" onClick={() => setChanging(true)}>Change</button>
            <button type="button" className="link-btn" disabled={link.isPending} onClick={() => link.mutate({ site_id: null, asset_id: null })}>Unlink</button>
          </span>
        )}
      </div>
      {error && <p className="snooze-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}

      {site && !changing && (
        <>
          <div className="pf-place-site">
            {p.can.view_sites ? <Link to={`/sites/${site.id}`}><b>{site.name ?? site.client ?? 'Site'}</b></Link> : <b>{site.name ?? site.client ?? 'Site'}</b>}
            <span className="pf-muted">
              {[site.site_type, site.open_work_orders > 1 ? `${site.open_work_orders} open work orders here` : null].filter(Boolean).join(' · ')}
            </span>
          </div>
          {(site.phone_1 || site.hours) && <p className="pf-place-line">{[site.phone_1, site.hours].filter(Boolean).join(' · ')}</p>}
          {site.access_notes && <p className="pf-place-line"><b>Getting in:</b> {site.access_notes}</p>}

          <div className="pf-place-head" style={{ marginTop: 10 }}>
            <span className="overline">Asset</span>
          </div>
          {p.asset ? (
            <div className="pf-place-site">
              {p.can.view_assets ? <Link to={`/assets/${p.asset.id}`}><b>{p.asset.name}</b></Link> : <b>{p.asset.name}</b>}
              <span className="pf-muted">{[p.asset.asset_type ?? p.asset.category, p.asset.model_number, p.asset.location].filter(Boolean).join(' · ')}</span>
              <span className="pf-place-chips">
                <AssetStatusChip status={p.asset.status} />
                <ConditionChip condition={p.asset.condition} />
                <WarrantyChip state={p.asset.warranty} expiresOn={p.asset.warranty_expires_on} />
              </span>
            </div>
          ) : (
            <p className="pf-place-line pf-muted">No asset named on this work order.</p>
          )}
          {p.can.link && p.site_assets.length > 0 && (
            <select
              className="fld pf-place-select"
              value={p.asset?.id ?? ''}
              disabled={link.isPending}
              onChange={(e) => link.mutate({ asset_id: e.target.value || null })}
              aria-label="The asset this work order is on"
            >
              <option value="">{p.asset ? 'No asset' : 'Choose the asset…'}</option>
              {p.site_assets.map((a) => (
                <option key={a.id} value={a.id}>{[a.name, a.location].filter(Boolean).join(' — ')}</option>
              ))}
            </select>
          )}
        </>
      )}

      {(!site || changing) && (
        p.can.link ? (
          <>
            {!site && <p className="pf-place-line pf-muted">This work order is not linked to a site record.</p>}
            {p.suggestions.length > 0 && !changing && (
              <ul className="pf-place-sugg">
                {p.suggestions.map((s) => (
                  <li key={s.id}>
                    <span>
                      <b>{s.name ?? s.client}</b>
                      <span className="pf-muted">{[s.address1, s.city, s.state].filter(Boolean).join(', ')}</span>
                    </span>
                    <button type="button" className="btn btn-sm" disabled={link.isPending} onClick={() => link.mutate({ site_id: s.id })}>Link</button>
                  </li>
                ))}
              </ul>
            )}
            <SitePicker value={null} onPick={(s) => { if (s) link.mutate({ site_id: s.id }); }} />
            {changing && <button type="button" className="link-btn" onClick={() => setChanging(false)}>Keep the current site</button>}
          </>
        ) : (
          <p className="pf-place-line pf-muted">This work order is not linked to a site record.</p>
        )
      )}
    </div>
  );
}
