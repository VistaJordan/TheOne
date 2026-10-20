/* 0089 — @mentions in work-order messages.
 *
 * Pure rules from packages/shared/src/mentions.ts (what counts as "@Name" in
 * a body, how the @ list filters, how a body is drawn) and source-text pins
 * on the API: the candidates are scoped per person, an id that is not a
 * candidate is refused, the rows commit with the message, and only the
 * people newly mentioned are notified. No database, no network. */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MENTION_MAX,
  MENTION_NOTICE_KIND,
  activeMentionQuery,
  bodyMentions,
  filterMentionCandidates,
  mentionsInBody,
  splitMentions,
  type MentionCandidate,
} from '@theone/shared';

const ROOT = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

const jordan = { id: 'p-1', name: 'Jordan Brown', role_label: 'Admin' };
const jo = { id: 'p-2', name: 'Jo', role_label: 'OM' };
const jeff = { id: 'p-3', name: 'Jeff S', role_label: 'AP' };
const people: MentionCandidate[] = [jordan, jo, jeff];

describe('bodyMentions', () => {
  it('finds "@Name" anywhere, case-insensitively', () => {
    expect(bodyMentions('@Jordan Brown can you check?', 'Jordan Brown')).toBe(true);
    expect(bodyMentions('Thanks @jordan brown.', 'Jordan Brown')).toBe(true);
    expect(bodyMentions('cc (@Jordan Brown)', 'Jordan Brown')).toBe(true);
  });
  it('needs the whole name and a boundary on both sides', () => {
    expect(bodyMentions('@Jordan can you check?', 'Jordan Brown')).toBe(false);
    expect(bodyMentions('@Jordan Browning', 'Jordan Brown')).toBe(false);
    expect(bodyMentions('jordan@Jordan Brown', 'Jordan Brown')).toBe(false); // an email-like run
    expect(bodyMentions('Jordan Brown', 'Jordan Brown')).toBe(false); // no @
  });
  it('treats regex characters in a name literally', () => {
    expect(bodyMentions('@A.B (Ops)', 'A.B (Ops)')).toBe(true);
    expect(bodyMentions('@AxB (Ops)', 'A.B (Ops)')).toBe(false);
  });
});

describe('mentionsInBody', () => {
  it('keeps only the picked people still named, once each, in pick order', () => {
    const body = '@Jeff S and @Jordan Brown — @Jeff S again';
    expect(mentionsInBody(body, [jordan, jeff, jordan, jo]).map((p) => p.id)).toEqual(['p-1', 'p-3']);
  });
  it('drops a person whose name was deleted from the draft', () => {
    expect(mentionsInBody('never mind', [jordan])).toEqual([]);
  });
  it('a short name inside a longer mention is not a mention of the short name', () => {
    expect(mentionsInBody('@Jordan Brown', [jo])).toEqual([]);
    expect(mentionsInBody('@Jo, see this', [jo])).toEqual([jo]);
  });
});

describe('splitMentions', () => {
  it('cuts a body into text and mentions of the people it mentions only', () => {
    const segs = splitMentions('Hi @Jordan Brown, ask @someone and @Jeff S.', [
      { id: 'p-1', name: 'Jordan Brown' },
      { id: 'p-3', name: 'Jeff S' },
    ]);
    expect(segs).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'mention', text: '@Jordan Brown', id: 'p-1' },
      { kind: 'text', text: ', ask @someone and ' },
      { kind: 'mention', text: '@Jeff S', id: 'p-3' },
      { kind: 'text', text: '.' },
    ]);
  });
  it('joins the segments back into the body exactly', () => {
    const body = '@jo — @Jordan Brown\n@Jo';
    const segs = splitMentions(body, [{ id: 'p-2', name: 'Jo' }, { id: 'p-1', name: 'Jordan Brown' }]);
    expect(segs.map((s) => s.text).join('')).toBe(body);
    expect(segs.filter((s) => s.kind === 'mention').map((s) => (s as { id: string }).id)).toEqual(['p-2', 'p-1', 'p-2']);
  });
  it('is plain text with no mentions', () => {
    expect(splitMentions('no one', [])).toEqual([{ kind: 'text', text: 'no one' }]);
    expect(splitMentions('', [])).toEqual([]);
  });
});

describe('activeMentionQuery', () => {
  it('reads the "@query" at the caret, spaces allowed', () => {
    expect(activeMentionQuery('hi @jor', 7)).toEqual({ start: 3, query: 'jor' });
    expect(activeMentionQuery('@Jordan B', 9)).toEqual({ start: 0, query: 'Jordan B' });
    expect(activeMentionQuery('hi @', 4)).toEqual({ start: 3, query: '' });
  });
  it('is not a query after an email-like run, a line break, a leading space or 40 characters', () => {
    expect(activeMentionQuery('me@jor', 6)).toBeNull();
    expect(activeMentionQuery('@jor\nok', 7)).toBeNull();
    expect(activeMentionQuery('@ jor', 5)).toBeNull();
    expect(activeMentionQuery(`@${'x'.repeat(41)}`, 42)).toBeNull();
    expect(activeMentionQuery('no at sign', 10)).toBeNull();
  });
});

describe('filterMentionCandidates', () => {
  it('puts word-start matches before contains matches', () => {
    expect(filterMentionCandidates(people, 'br').map((p) => p.id)).toEqual(['p-1']);
    expect(filterMentionCandidates(people, 'j').map((p) => p.id)).toEqual(['p-1', 'p-2', 'p-3']);
    expect(filterMentionCandidates(people, 'rda').map((p) => p.id)).toEqual(['p-1']);
  });
  it('lists everyone (up to the limit) for an empty query', () => {
    expect(filterMentionCandidates(people, '', 2)).toHaveLength(2);
  });
});

describe('API pins', () => {
  const svc = read('apps', 'api', 'src', 'services', 'woMessages.ts');
  const routes = read('apps', 'api', 'src', 'routes', 'workOrders.ts');
  const mig = read('packages', 'db', 'migrations', '0088_comment_mentions.sql');

  it('offers only active humans with the work order and the Messages tab in their own scope', () => {
    expect(svc).toMatch(/p\.kind = 'human' AND p\.status <> 'disabled'/);
    expect(svc).toMatch(/allow\('work_orders', 'view'\) && allow\(tabPermKey\('messages'\), 'view'\)/);
    expect(svc).toMatch(/woScopeSql\(actor, p\)/);
  });
  it('refuses an id that is not a candidate, and keeps only names still in the body', () => {
    expect(svc).toMatch(/code: 'MENTION_NOT_ALLOWED'/);
    expect(svc).toMatch(/return mentionsInBody\(body, ids\.map/);
  });
  it('writes the mention rows inside the message transaction and notifies after it', () => {
    const post = svc.slice(svc.indexOf('export async function postMessage'), svc.indexOf('// ── Editing'));
    const tx = post.indexOf('withTransaction');
    expect(post.indexOf('INSERT INTO comment_mention')).toBeGreaterThan(tx);
    expect(post.indexOf('notifyMentioned(')).toBeGreaterThan(post.indexOf('if (!commentId)'));
  });
  it('an edit tells only the people it added', () => {
    expect(svc).toMatch(/notifyMentioned\(taskId, messageId, body, added, actor\)/);
  });
  it('the notice is the mention kind and links to the message', () => {
    expect(MENTION_NOTICE_KIND).toBe('wo_mention');
    expect(svc).toMatch(/\?tab=messages&msg=\$\{commentId\}/);
  });
  it('the route bounds the list and resolves the work order through the scope', () => {
    expect(MENTION_MAX).toBe(20);
    expect(routes).toMatch(/z\.array\(z\.string\(\)\.uuid\(\)\)\.max\(MENTION_MAX\)/);
    const route = routes.slice(routes.indexOf("'/work-orders/:id/mention-candidates'"));
    expect(route.slice(0, 600)).toMatch(/resolveTaskId\(id, p\)/);
  });
  it('the migration cascades both keys so the seed TRUNCATE and a deleted message stay clean', () => {
    expect(mig).toMatch(/REFERENCES comment\(id\) ON DELETE CASCADE/);
    expect(mig).toMatch(/REFERENCES principal\(id\) ON DELETE CASCADE/);
    expect(mig).not.toMatch(/^\s*(BEGIN|COMMIT)\b/im);
  });
});
