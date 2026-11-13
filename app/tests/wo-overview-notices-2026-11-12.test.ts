/**
 * Elise, 2026-11-12: the Overview layout, the header fold, Emergency for the
 * dispatchers (on, never off) and the message notices for the work order's
 * dispatcher, TL and ATL.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_NOTICE_KIND,
  MESSAGE_WATCHER_KEYS,
  NOTICE_TYPES,
  mayClearEmergency,
  messageWatcherNames,
} from '@theone/shared';

const root = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

describe('message watchers', () => {
  it('are the Assignee, TL and ATL seats — not the AM', () => {
    expect([...MESSAGE_WATCHER_KEYS]).toEqual(['Assignee', 'TL', 'ATL']);
    expect(messageWatcherNames({ Assignee: 'Ana B, Carl D', TL: 'Tess', ATL: 'ana b', AM: 'Amy' })).toEqual([
      'Ana B',
      'Carl D',
      'Tess',
    ]);
    expect(messageWatcherNames(null)).toEqual([]);
  });

  it('the notice kind has a name on the Notifications page', () => {
    expect(MESSAGE_NOTICE_KIND).toBe('wo_message');
    expect(NOTICE_TYPES[MESSAGE_NOTICE_KIND]).toBeDefined();
  });

  it('postMessage tells the watchers after the mention notice, skipping those mentioned', () => {
    const src = read('apps/api/src/services/woMessages.ts');
    expect(src).toContain('await notifyWatchers(taskId, commentId, input.body, input.client_visible, mentioned, actor);');
    expect(src).toContain("kind: 'wo_message'");
    expect(src).toContain('mentionCandidates(taskId, messageWatcherNames(row.fields))');
  });
});

describe('Emergency: dispatchers raise it, never clear it', () => {
  it('only the dispatcher tiers are refused; super admins never', () => {
    for (const r of ['om', 'senior_om', 'om_probation']) expect(mayClearEmergency(r, false)).toBe(false);
    for (const r of ['tl', 'atl', 'am', 'admin', 'oa', 'vr_officer']) expect(mayClearEmergency(r, false)).toBe(true);
    expect(mayClearEmergency('om', true)).toBe(true);
  });

  it('the field editor, bulk edit and the header ask it', () => {
    expect(read('apps/api/src/services/woFieldValues.ts')).toContain('await assertMayClearEmergency(actorId, tx);');
    expect(read('apps/api/src/services/woBulk.ts')).toContain('if (emg && !flagTicked(emg.value)) await assertMayClearEmergency(actorId);');
    expect(read('apps/web/src/components/wo/WoHeader.tsx')).toContain('title={EMERGENCY_CLEAR_SENTENCE}');
  });
});

describe('Overview and the header', () => {
  const page = read('apps/web/src/pages/WorkOrderDetailPage.tsx');
  it('leads with Job details and Dates; no soft-close checklist; People in the rail', () => {
    expect(page).toContain('<OverviewDetailsCard wo={wo} />');
    expect(page).not.toContain('<SoftCloseChecklist');
    expect(page).toContain("top={tab === 'overview' && showPeople ? <PeopleCard wo={wo} /> : undefined}");
    expect(page).toContain("responsibility={tab !== 'overview'}");
  });
  it('the header folds away from Overview', () => {
    expect(page).toContain("folded={tab !== 'overview'}");
  });
});
