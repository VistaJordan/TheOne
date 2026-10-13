/* 0074 — Admin › Integrations. The pure half: the connector list is complete
 * and consistent (every key described once, every logo shipped with the web
 * app, the only locked one is sign-in), and the switch's in-memory copy
 * answers "on" for anything it has never read. The database half (the page
 * and the toggles) is exercised against the live site. */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  INTEGRATIONS,
  INTEGRATION_BY_KEY,
  INTEGRATION_GROUPS,
  INTEGRATION_KEYS,
} from '../packages/shared/src/integrations';
import { ADMIN_PERM_SECTIONS } from '../packages/shared/src/permissions';
import { integrationOn } from '../apps/api/src/services/integrations';
import { EcotrakClient } from '../apps/api/src/modules/integrations/ecotrak/client';

describe('the connector list', () => {
  it('describes every key exactly once, in a known group', () => {
    expect(INTEGRATIONS.map((d) => d.key).sort()).toEqual([...INTEGRATION_KEYS].sort());
    expect(new Set(INTEGRATIONS.map((d) => d.key)).size).toBe(INTEGRATIONS.length);
    for (const d of INTEGRATIONS) {
      expect(INTEGRATION_GROUPS).toContain(d.group);
      expect(d.summary.length).toBeGreaterThan(20);
      expect(d.off_means.length).toBeGreaterThan(20);
      expect(INTEGRATION_BY_KEY[d.key]).toBe(d);
    }
  });
  it('ships a picture for each tool', () => {
    for (const d of INTEGRATIONS) {
      const file = resolve(__dirname, '..', 'apps', 'web', 'public', 'brand', 'integrations', d.logo);
      expect(existsSync(file), `${d.key} → ${d.logo}`).toBe(true);
    }
  });
  it('locks only the sign-in', () => {
    expect(INTEGRATIONS.filter((d) => d.locked).map((d) => d.key)).toEqual(['entra']);
  });
  it('is an admin section of its own', () => {
    expect(ADMIN_PERM_SECTIONS.find((s) => s.slug === 'integrations')?.actions).toEqual(['view', 'edit']);
  });
});

describe('integrationOn', () => {
  it('answers on for anything never read (before 0074, or with the database away)…', () => {
    for (const k of INTEGRATION_KEYS) {
      if (k === 'ecotrak' || k === 'ecotrak_outbound') continue;
      expect(integrationOn(k)).toBe(true);
    }
  });
  it('…except Ecotrak, both ways: if in doubt it is off (0079)', () => {
    expect(integrationOn('ecotrak')).toBe(false);
    expect(integrationOn('ecotrak_outbound')).toBe(false);
    expect(INTEGRATIONS.filter((d) => d.default_on === false).map((d) => d.key).sort()).toEqual(['ecotrak', 'ecotrak_outbound']);
  });
});

describe('Ecotrak (0079)', () => {
  it('The One → Ecotrak cannot be turned on: nothing that writes exists', () => {
    expect(INTEGRATION_BY_KEY.ecotrak_outbound.locked_off).toBeTruthy();
    expect(INTEGRATIONS.filter((d) => d.locked_off).map((d) => d.key)).toEqual(['ecotrak_outbound']);
  });

  it('the client does not contact Ecotrak, not even for a token, while the switch is off', async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      throw new Error('no network in tests');
    }) as typeof fetch;
    try {
      const c = new EcotrakClient({ tokenUrl: 'https://auth.example/token', baseUrl: 'https://api.example', clientId: 'x', clientSecret: 'y' });
      await expect(c.fetchUpdatedSince(new Date())).rejects.toThrow(/switched off/);
      await expect(c.fetchWorkOrder('1')).rejects.toThrow(/switched off/);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('every Vercel cron path gets past the sign-in guard (it checks CRON_SECRET itself)', () => {
    const vercel = JSON.parse(readFileSync(resolve(__dirname, '..', 'vercel.json'), 'utf8')) as { crons: { path: string }[] };
    const guard = readFileSync(resolve(__dirname, '..', 'apps', 'api', 'src', 'plugins', 'authGuard.ts'), 'utf8');
    for (const c of vercel.crons) expect(guard, c.path).toContain(`'${c.path}'`);
  });

  it('the client has no method that writes to Ecotrak', () => {
    const src = readFileSync(resolve(__dirname, '..', 'apps', 'api', 'src', 'modules', 'integrations', 'ecotrak', 'client.ts'), 'utf8');
    expect(src).not.toMatch(/method:\s*'(PUT|PATCH|DELETE)'/);
    // The only POST is the OAuth token exchange.
    expect(src.match(/method:\s*'POST'/g)?.length ?? 0).toBe(1);
  });
});
