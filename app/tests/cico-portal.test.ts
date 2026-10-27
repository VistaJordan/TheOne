/* Elise, 2026-10-27 — which portal (migration 0098).
 *
 * An FM whose techs check in on the client's portal names WHICH portal in
 * Admin › Custom fields › Check-in method by FM, and a visit on that FM's
 * work order reads "Portal: Service Channel". The wording is pure; the wiring
 * is pinned to the source.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CICO_PORTAL_METHOD, cicoMethodLabel, cicoMethodText } from '../packages/shared/src/index';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('how a check-in method reads', () => {
  it('a portal reads "Portal: <name>"', () => {
    expect(cicoMethodLabel('Portal', 'Service Channel')).toBe('Portal: Service Channel');
    expect(cicoMethodLabel('Portal', ' Corrigo ')).toBe('Portal: Corrigo');
  });

  it('a portal with no name, or another method, reads as the method alone', () => {
    expect(cicoMethodLabel('Portal', null)).toBe('Portal');
    expect(cicoMethodLabel('Portal', '  ')).toBe('Portal');
    expect(cicoMethodLabel('IVR', 'Service Channel')).toBe('IVR');
    expect(cicoMethodLabel(null, 'Corrigo')).toBeNull();
  });

  it('the legacy CICO Method mirror carries the portal before the detail', () => {
    expect(cicoMethodText('Portal', 'Submit request on Teams', 'Corrigo')).toBe('Portal: Corrigo - Submit request on Teams');
    expect(cicoMethodText('IVR', '(866) 254-8780')).toBe('IVR - (866) 254-8780');
    expect(CICO_PORTAL_METHOD).toBe('Portal');
  });
});

describe('the wiring', () => {
  it('0098 adds the two columns', () => {
    const sql = read('packages/db/migrations/0098_cico_portal.sql');
    expect(sql).toContain('ALTER TABLE fm_cico_method ADD COLUMN IF NOT EXISTS portal text;');
    expect(sql).toContain('ALTER TABLE wo_visit       ADD COLUMN IF NOT EXISTS method_portal text;');
  });

  it('the FM table keeps a portal only beside Portal, and a new visit takes the FM\'s', () => {
    const visits = read('apps/api/src/services/visits.ts');
    expect(visits).toContain('return method === CICO_PORTAL_METHOD && p ? p : null;');
    expect(visits).toContain('[name, method, note, actorId, portalFor(method, portal)]');
    expect(visits).toContain('if (portal === undefined) portal = entry && entry.method === method ? entry.portal : null;');
    expect(visits).toContain('next.method_portal = portalFor(next.method, next.method_portal);');
    expect(visits).toContain('cicoMethodText(v.method, v.method_detail, v.method_portal)');
  });

  it('0099 moves the twelve IVR / "Service Channel" FMs to Portal: Service Channel, seed in step', () => {
    const sql = read('packages/db/migrations/0099_service_channel_portal.sql');
    expect(sql).toContain("SET method = 'Portal', portal = 'Service Channel', detail = NULL");
    expect(sql).toContain("AND btrim(detail) = 'Service Channel'");
    const seed = read('packages/db/src/seed.ts');
    expect(seed).not.toContain('"IVR", "Service Channel"]');
    expect(seed.split('"Portal", null, "Service Channel"]').length - 1).toBe(12);
  });

  it('the visit log draws "Portal: <name>"', () => {
    expect(read('apps/web/src/components/wo/CicoCard.tsx')).toContain('cicoMethodLabel(v.method, v.method_portal)');
  });
});
