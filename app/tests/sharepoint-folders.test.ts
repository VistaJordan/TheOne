/* 0071 — SharePoint folders, the pure half. The database and Graph halves
 * (services/sharepoint.ts, lib/graphDrive.ts) create the folders; these pin
 * the decisions that, wrong, would file a work order in the wrong place or
 * fork the live tree: how the settings are made whole, how a switch stamps
 * its "since", how names are cleaned, which number follows "WO#", and the
 * exact shape of the paths the team already has in SharePoint.
 */

import { describe, it, expect } from 'vitest';
import {
  SHAREPOINT_DEFAULTS,
  cleanSharePointSettings,
  describeSharePointStatus,
  sharePointClientPath,
  sharePointEntityPath,
  sharePointSafeName,
  sharePointStateAbbr,
  sharePointWoFolderName,
  sharePointWoNumber,
  sharePointWoPath,
  sharePointYearOf,
} from '../packages/shared/src/sharepoint';

const NOW = '2026-10-06T12:00:00.000Z';

describe('settings', () => {
  it('defaults match the live tree', () => {
    const s = cleanSharePointSettings({}, NOW);
    expect(s).toEqual(SHAREPOINT_DEFAULTS);
    expect(s.root_path).toBe('General/Work Orders - {year}');
    expect(s.entity_folder).toBe('{year} - {entity}');
    expect(s.wo_folder).toBe('WO#{number}, {city}, {state}');
  });

  it('keeps only an https site url, trimmed of its trailing slash', () => {
    expect(cleanSharePointSettings({ site_url: 'https://x.sharepoint.com/sites/SFM/' }, NOW).site_url).toBe('https://x.sharepoint.com/sites/SFM');
    expect(cleanSharePointSettings({ site_url: 'x.sharepoint.com' }, NOW).site_url).toBeNull();
    expect(cleanSharePointSettings({ site_url: '' }, NOW).site_url).toBeNull();
  });

  it('a blank template falls back to the default rather than an empty path', () => {
    const s = cleanSharePointSettings({ root_path: '  ', library: '', wo_folder: '/WO {number}/' }, NOW);
    expect(s.root_path).toBe(SHAREPOINT_DEFAULTS.root_path);
    expect(s.library).toBe('Documents');
    expect(s.wo_folder).toBe('WO {number}');
  });

  it('turning a switch on stamps when; keeping it on keeps the stamp; off clears it', () => {
    const on = cleanSharePointSettings({ wo_folders: true }, NOW);
    expect(on.wo_folders_since).toBe(NOW);
    const still = cleanSharePointSettings({ ...on, wo_folders: true }, '2026-11-01T00:00:00.000Z');
    expect(still.wo_folders_since).toBe(NOW);
    const off = cleanSharePointSettings({ ...on, wo_folders: false }, '2026-11-01T00:00:00.000Z');
    expect(off.wo_folders_since).toBeNull();
    expect(off.client_folders_since).toBeNull();
  });

  it('a posted "since" never turns a switch on by itself', () => {
    const s = cleanSharePointSettings({ copy_files_since: NOW }, NOW);
    expect(s.copy_files).toBe(false);
    expect(s.copy_files_since).toBeNull();
  });
});

describe('names', () => {
  it('replaces what SharePoint refuses and trims trailing dots and spaces', () => {
    expect(sharePointSafeName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(sharePointSafeName('  Mimi\'s Cafe.. ')).toBe("Mimi's Cafe");
    expect(sharePointSafeName('two   spaces')).toBe('two spaces');
  });

  it('abbreviates a state, keeps an abbreviation, passes anything else through', () => {
    expect(sharePointStateAbbr('Arizona')).toBe('AZ');
    expect(sharePointStateAbbr('az')).toBe('AZ');
    expect(sharePointStateAbbr('Ontario')).toBe('Ontario');
    expect(sharePointStateAbbr('')).toBeNull();
    expect(sharePointStateAbbr(null)).toBeNull();
  });

  it('WO# takes the Ecotrak id for a synced work order and drops a WO- prefix otherwise', () => {
    expect(sharePointWoNumber('ECO-345437406', '345437406')).toBe('345437406');
    expect(sharePointWoNumber('WO-39403', null)).toBe('39403');
    expect(sharePointWoNumber('WO#39403', null)).toBe('39403');
    expect(sharePointWoNumber('wo 39403', null)).toBe('39403');
    expect(sharePointWoNumber('PM-ACME-2026-10-06', null)).toBe('PM-ACME-2026-10-06');
    expect(sharePointWoNumber('ECO-1', '')).toBe('ECO-1');
  });
});

describe('paths', () => {
  const s = SHAREPOINT_DEFAULTS;

  it('the entity folder sits under the year root', () => {
    expect(sharePointEntityPath(s, 2026, 'SFM')).toBe('General/Work Orders - 2026/2026 - SFM');
  });

  it('a client folder is the client name under its entity', () => {
    expect(sharePointClientPath(s, { year: 2026, entity: 'SFM', client: 'Bashas' })).toBe(
      'General/Work Orders - 2026/2026 - SFM/Bashas',
    );
  });

  it('the work-order folder reads WO#number, City, ST', () => {
    const p = { year: 2026, entity: 'SFM', client: 'First watch', number: '345437406', city: 'Colorado Springs', state: 'Colorado' };
    expect(sharePointWoFolderName(s, p)).toBe('WO#345437406, Colorado Springs, CO');
    expect(sharePointWoPath(s, p)).toBe('General/Work Orders - 2026/2026 - SFM/First watch/WO#345437406, Colorado Springs, CO');
  });

  it('a missing city or state is dropped, never left as a dangling comma', () => {
    const base = { year: 2026, entity: 'AF', client: 'Vuori', number: '12' };
    expect(sharePointWoFolderName(s, { ...base, city: null, state: 'TX' })).toBe('WO#12, TX');
    expect(sharePointWoFolderName(s, { ...base, city: 'Tyler', state: null })).toBe('WO#12, Tyler');
    expect(sharePointWoFolderName(s, { ...base, city: '', state: '' })).toBe('WO#12');
  });

  it('a slash in a client or city name cannot create a deeper folder', () => {
    expect(sharePointClientPath(s, { year: 2026, entity: 'RF', client: 'A/B Stores' })).toBe('General/Work Orders - 2026/2026 - RF/A-B Stores');
    expect(sharePointWoFolderName(s, { year: 2026, entity: 'RF', client: 'x', number: '1', city: 'St/Louis', state: 'MO' })).toBe('WO#1, St-Louis, MO');
  });

  it('a renamed template is honoured', () => {
    const custom = { ...s, root_path: 'Work Orders/{year}', entity_folder: '{entity}', wo_folder: '{number} - {city}' };
    expect(sharePointWoPath(custom, { year: 2027, entity: 'BKR', client: 'MAC', number: '77', city: 'Omaha', state: 'NE' })).toBe(
      'Work Orders/2027/BKR/MAC/77 - Omaha',
    );
  });

  it('files under the year received, else created, else this year', () => {
    expect(sharePointYearOf('2025-12-30', '2026-01-02T00:00:00Z')).toBe(2025);
    expect(sharePointYearOf(null, '2026-01-02T00:00:00Z')).toBe(2026);
    expect(sharePointYearOf(null, null, new Date('2031-05-05T00:00:00Z'))).toBe(2031);
    expect(sharePointYearOf('garbage', null, new Date('2031-05-05T00:00:00Z'))).toBe(2031);
  });
});

describe('status wording', () => {
  it('reads plainly on a chip', () => {
    expect(describeSharePointStatus({ status: 'created', error: null, attempts: 1 })).toBe('In SharePoint');
    expect(describeSharePointStatus({ status: 'pending', error: null, attempts: 0 })).toBe('Folder pending');
    expect(describeSharePointStatus({ status: 'pending', error: 'x', attempts: 2 })).toBe('Retrying…');
    expect(describeSharePointStatus({ status: 'failed', error: 'No client named Foo on file', attempts: 3 })).toBe('Folder failed — No client named Foo on file');
    expect(describeSharePointStatus({ status: 'skipped', error: null, attempts: 0 })).toBe('Not filed');
  });
});
