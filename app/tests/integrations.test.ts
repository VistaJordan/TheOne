/* 0074 — Admin › Integrations. The pure half: the connector list is complete
 * and consistent (every key described once, every logo shipped with the web
 * app, the only locked one is sign-in), and the switch's in-memory copy
 * answers "on" for anything it has never read. The database half (the page
 * and the toggles) is exercised against the live site. */

import { existsSync } from 'node:fs';
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
  it('answers on for anything never read (before 0074, or with the database away)', () => {
    for (const k of INTEGRATION_KEYS) expect(integrationOn(k)).toBe(true);
  });
});
