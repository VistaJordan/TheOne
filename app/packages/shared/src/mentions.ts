// @mentions in work-order messages (migration 0089).
//
// A mention is "@Display Name" typed in the body, picked from the people who
// may open that work order. The body stays plain text on purpose: a
// client-visible message goes to the client's CMMS as written, so no markup
// token may ride in it. Which people a message mentions is sent beside the
// body as ids (`mentions`) and kept in `comment_mention`; the API keeps only
// the ids whose "@Name" is still in the text, so deleting the name from the
// draft drops the mention. Pure vocabulary, shared by the API and the browser.

/** Someone who can be mentioned on a work order: an active person who can
 *  open it and read its Messages tab. */
export interface MentionCandidate {
  id: string;
  name: string;
  role_label: string | null;
}

export interface MentionCandidatesResponse {
  items: MentionCandidate[];
}

/** A person a message mentions, as the thread draws it. */
export interface MessageMention {
  id: string;
  name: string;
}

/** Most people one message may mention. */
export const MENTION_MAX = 20;

/** The `app_notice.kind` a mention raises. */
export const MENTION_NOTICE_KIND = 'wo_mention';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A mention starts the text or follows something that is not a letter, digit
// or underscore (so an email address is not a mention), and ends at the end
// or before one of those.
const WORD = '[\\p{L}\\p{N}_]';

function mentionRe(names: readonly string[]): RegExp | null {
  const usable = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))]
    // Longest first, so "@Jo Ann Smith" wins over "@Jo Ann".
    .sort((a, b) => b.length - a.length)
    .map(escapeRe);
  if (usable.length === 0) return null;
  return new RegExp(`(?<!${WORD})@(${usable.join('|')})(?!${WORD})`, 'giu');
}

/** Does the body still carry "@Name" for this person? Case-insensitive. */
export function bodyMentions(body: string, name: string): boolean {
  const re = mentionRe([name]);
  return re ? re.test(body) : false;
}

/** The people from `picked` whose "@Name" is in the body, each once, in the
 *  order they were picked. */
export function mentionsInBody<T extends { id: string; name: string }>(body: string, picked: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const p of picked) {
    if (seen.has(p.id)) continue;
    if (!bodyMentions(body, p.name)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

export type MentionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; id: string };

/** The body cut into plain text and mentions, for drawing. Only the people
 *  the message actually mentions are highlighted; any other "@word" is text. */
export function splitMentions(body: string, mentions: readonly MessageMention[]): MentionSegment[] {
  const re = mentionRe(mentions.map((m) => m.name));
  if (!re) return body ? [{ kind: 'text', text: body }] : [];
  const byName = new Map(mentions.map((m) => [m.name.trim().toLowerCase(), m.id]));
  const out: MentionSegment[] = [];
  let last = 0;
  for (const m of body.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: body.slice(last, at) });
    const id = byName.get(m[1].toLowerCase());
    out.push(id ? { kind: 'mention', text: m[0], id } : { kind: 'text', text: m[0] });
    last = at + m[0].length;
  }
  if (last < body.length) out.push({ kind: 'text', text: body.slice(last) });
  return out;
}

/** The "@query" being typed at the caret, or null when the caret is not in
 *  one. A query may hold spaces (names do) but not a line break, and stops
 *  being one after 40 characters. `start` is the index of the "@". */
export function activeMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && new RegExp(WORD, 'u').test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\r\n]/.test(query) || /^\s/.test(query)) return null;
  return { start: at, query };
}

/** Candidates matching what was typed after "@": any word of the name
 *  starting with the query, else the name containing it. */
export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
  limit = 8,
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return candidates.slice(0, limit);
  const starts: MentionCandidate[] = [];
  const contains: MentionCandidate[] = [];
  for (const c of candidates) {
    const n = c.name.toLowerCase();
    if (n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q))) starts.push(c);
    else if (n.includes(q)) contains.push(c);
  }
  return [...starts, ...contains].slice(0, limit);
}
