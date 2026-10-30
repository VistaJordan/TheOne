/**
 * Client Portal Type offers 7-Eleven and follows the client's check-in row
 * (Elise, 2026-10-30; migration 0113, shared clientCico.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pickClientTeam, portalTypeFromCico, portalTypeOption } from '@theone/shared';

const OPTIONS = ['Ecotrak', 'Corrigo', 'ServiceChannel', '7-Eleven'];
const root = join(__dirname, '..');

describe('portalTypeOption', () => {
  it('matches spellings to the option', () => {
    expect(portalTypeOption('7-11', OPTIONS)).toBe('7-Eleven');
    expect(portalTypeOption('7 eleven', OPTIONS)).toBe('7-Eleven');
    expect(portalTypeOption('EcoTrack', OPTIONS)).toBe('Ecotrak');
    expect(portalTypeOption('Service Channel', OPTIONS)).toBe('ServiceChannel');
    expect(portalTypeOption('Metryx', OPTIONS)).toBeNull();
    expect(portalTypeOption('', OPTIONS)).toBeNull();
  });
});

describe('portalTypeFromCico', () => {
  it('reads a Portal row', () => {
    expect(portalTypeFromCico({ method: 'Portal', portal: '7-11', detail: '' }, OPTIONS)).toBe('7-Eleven');
    expect(portalTypeFromCico({ method: 'Portal', portal: 'Corrigo', detail: null }, OPTIONS)).toBe('Corrigo');
  });
  it('reads the portal the sheet put in front of an IVR detail', () => {
    expect(portalTypeFromCico({ method: 'IVR', portal: null, detail: 'Service Channel · (516) 500-7776' }, OPTIONS)).toBe('ServiceChannel');
  });
  it('fills nothing for an email row or a portal the list lacks', () => {
    expect(portalTypeFromCico({ method: 'Email', portal: null, detail: null }, OPTIONS)).toBeNull();
    expect(portalTypeFromCico({ method: 'Portal', portal: 'Metryx', detail: 'Picture + manager name' }, OPTIONS)).toBeNull();
    expect(portalTypeFromCico(null, OPTIONS)).toBeNull();
  });
  it('picks the row by client and Comp like the account team', () => {
    const rows = [{ client: '7-11', billing_entity: 'SFM', portal_type: '7-Eleven' }];
    expect(pickClientTeam(rows, '7-11', 'SFM')?.portal_type).toBe('7-Eleven');
    expect(pickClientTeam(rows, '7-11', null)?.portal_type).toBe('7-Eleven');
    expect(pickClientTeam(rows, '7-11', 'AF')).toBeNull();
  });
});

describe('migration and seed keep in step', () => {
  it('both offer 7-Eleven', () => {
    const mig = readFileSync(join(root, 'packages/db/migrations/0113_portal_type_7eleven.sql'), 'utf8');
    const seed = readFileSync(join(root, 'packages/db/src/seed.ts'), 'utf8');
    expect(mig).toContain("'7-Eleven'");
    expect(seed).toMatch(/key: 'Client Portal Type'.*'7-Eleven'/);
  });
});
