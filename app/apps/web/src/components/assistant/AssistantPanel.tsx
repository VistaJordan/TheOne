// 0068 · The assistant: a button in the top bar and the panel it opens.
//
// The panel hangs on the right edge over whatever page is open and does not
// block it — the point is to ask about what you are looking at. Its state
// lives in a module-level store, not in the component: AppShell is rendered by
// each page, so a component's own state (and a question still being answered)
// would be lost on every navigation, including the click on a link in an
// answer.
//
// Four views: the chat, the person's earlier conversations, and — for those
// who may teach it — the notes it reads before every answer and the answers
// people marked.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ASSISTANT_NOTE_BODY_MAX, ASSISTANT_NOTE_TITLE_MAX, ASSISTANT_QUESTION_MAX, assistantLinkOk } from '@theone/shared';
import type { AssistantConversationSummary, AssistantFeedbackItem, AssistantMessage, AssistantNote } from '@theone/shared';
import {
  ApiRequestError,
  askAssistant,
  deleteAssistantConversation,
  deleteAssistantNote,
  getAssistantConversation,
  getAssistantFeedback,
  getAssistantStatus,
  listAssistantConversations,
  listAssistantNotes,
  markAssistantReviewed,
  rateAssistantAnswer,
  saveAssistantNote,
} from '../../api/client';
import { Icon } from '../Icon';

// ── The store ────────────────────────────────────────────────────────────────

type View = 'chat' | 'history' | 'notes' | 'review';

interface State {
  open: boolean;
  view: View;
  conversation: AssistantConversationSummary | null;
  messages: AssistantMessage[];
  /** The question being answered right now. */
  pending: string | null;
  problem: string | null;
  loading: boolean;
  /** A note the reviewer started from a marked answer. */
  noteDraft: { title: string; body: string } | null;
}

let state: State = {
  open: false,
  view: 'chat',
  conversation: null,
  messages: [],
  pending: null,
  problem: null,
  loading: false,
  noteDraft: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const useAssistant = (): State => useSyncExternalStore(subscribe, () => state);

const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError || e instanceof Error ? e.message : fallback);

function newChat(): void {
  set({ view: 'chat', conversation: null, messages: [], problem: null });
}

async function openConversation(id: string): Promise<void> {
  set({ view: 'chat', loading: true, problem: null });
  try {
    const c = await getAssistantConversation(id);
    set({ conversation: { id: c.id, title: c.title, updated_at: c.updated_at }, messages: c.messages, loading: false });
  } catch (e) {
    set({ loading: false, problem: errText(e, 'That conversation could not be opened.') });
  }
}

/** Runs to the end whatever happens to the component that started it. */
async function send(question: string, page: string, onDone: () => void): Promise<void> {
  if (state.pending) return;
  const asked = state.conversation?.id ?? null;
  set({ pending: question, problem: null });
  try {
    const res = await askAssistant({ conversation_id: asked, question, page });
    // The person may have started a new chat while this one was answering.
    const still = (state.conversation?.id ?? null) === asked;
    set(
      still
        ? { pending: null, conversation: res.conversation, messages: [...state.messages, res.question, res.answer] }
        : { pending: null },
    );
  } catch (e) {
    set({ pending: null, problem: errText(e, 'The question could not be sent.') });
  }
  onDone();
}

function replaceMessage(m: AssistantMessage): void {
  set({ messages: state.messages.map((x) => (x.id === m.id ? m : x)) });
}

// ── A reply, drawn ───────────────────────────────────────────────────────────
// Replies use a small, fixed subset: paragraphs, "- " lists, "1. " steps, **bold**, `code`
// and links into the app. Anything else is shown as the text it is — no HTML
// from a reply is ever interpreted.

const INLINE = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyBase}-${n++}`;
    if (m[1] !== undefined) out.push(<strong key={key}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>);
    else if (assistantLinkOk(m[4])) out.push(<Link key={key} to={m[4]}>{m[3]}</Link>);
    else out.push(m[3]);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Reply({ body }: { body: string }) {
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let items: string[] = [];
  let ordered = false;
  const flush = () => {
    const k = blocks.length;
    if (para.length > 0) blocks.push(<p key={`p${k}`}>{inline(para.join(' '), `p${k}`)}</p>);
    if (items.length > 0) {
      const lis = items.map((it, i) => <li key={i}>{inline(it, `l${k}-${i}`)}</li>);
      blocks.push(ordered ? <ol key={`l${k}`}>{lis}</ol> : <ul key={`l${k}`}>{lis}</ul>);
    }
    para = [];
    items = [];
  };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const step = /^\d+[.)]\s+(.*)$/.exec(line);
    const bullet = step ?? /^[-*•]\s+(.*)$/.exec(line);
    // A blank line inside a run of steps does not restart the numbering.
    if (line === '') {
      if (!(ordered && items.length > 0)) flush();
    } else if (bullet) {
      if (para.length > 0 || (items.length > 0 && ordered !== !!step)) flush();
      ordered = !!step;
      items.push(bullet[1]);
    } else {
      if (items.length > 0) flush();
      para.push(line.replace(/^#{1,6}\s+/, ''));
    }
  }
  flush();
  return <div className="asst-reply">{blocks}</div>;
}

// ── One answer ───────────────────────────────────────────────────────────────

function Answer({ m }: { m: AssistantMessage }) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(m.feedback_note ?? '');
  const rate = useMutation({
    mutationFn: (v: { rating: 1 | -1 | 0; note?: string | null }) => rateAssistantAnswer(m.id, v.rating, v.note),
    onSuccess: (res) => replaceMessage(res.message),
  });
  const failed = m.status === 'error' || m.status === 'declined';

  return (
    <div className={`asst-msg is-answer${failed ? ' is-failed' : ''}`}>
      <Reply body={m.body} />
      {m.lookups.length > 0 && (
        <details className="asst-lookups">
          <summary>
            Looked up {m.lookups.length} {m.lookups.length === 1 ? 'thing' : 'things'}
          </summary>
          <ul>
            {m.lookups.map((l, i) => (
              <li key={i} className={l.ok ? undefined : 'is-bad'}>{l.summary}</li>
            ))}
          </ul>
        </details>
      )}
      {!failed && (
        <div className="asst-rate">
          <button
            type="button"
            className={`asst-thumb${m.feedback === 1 ? ' is-on' : ''}`}
            aria-pressed={m.feedback === 1}
            aria-label="This answer was right"
            title="This answer was right"
            disabled={rate.isPending}
            onClick={() => {
              setNoteOpen(false);
              rate.mutate({ rating: m.feedback === 1 ? 0 : 1 });
            }}
          >
            <Icon name="thumb-up" size={14} />
          </button>
          <button
            type="button"
            className={`asst-thumb${m.feedback === -1 ? ' is-on is-down' : ''}`}
            aria-pressed={m.feedback === -1}
            aria-label="This answer was wrong"
            title="This answer was wrong"
            disabled={rate.isPending}
            onClick={() => {
              if (m.feedback === -1) {
                setNoteOpen(false);
                rate.mutate({ rating: 0 });
              } else {
                setNoteOpen(true);
                rate.mutate({ rating: -1, note: note.trim() || null });
              }
            }}
          >
            <Icon name="thumb-down" size={14} />
          </button>
          {m.feedback === -1 && !noteOpen && <span className="asst-rate-note">Marked wrong{m.feedback_note ? ` — ${m.feedback_note}` : ''}</span>}
        </div>
      )}
      {noteOpen && m.feedback === -1 && (
        <form
          className="asst-wrong"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            rate.mutate({ rating: -1, note: note.trim() || null }, { onSuccess: () => setNoteOpen(false) });
          }}
        >
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={1000}
            placeholder="What was wrong? (optional)"
            aria-label="What was wrong with this answer"
            autoFocus
          />
          <button type="submit" className="btn btn-sm is-ghost" disabled={rate.isPending}>Save</button>
        </form>
      )}
    </div>
  );
}

// ── The chat view ────────────────────────────────────────────────────────────

const STARTERS = ['Which work orders are waiting on a quote?', 'What is due today?', 'How do I save a view of the work orders list?'];
const WO_STARTERS = ['Summarise this work order', 'What happened on this work order in the last week?', 'Is anything blocking this work order?'];

function Chat({ configured, remaining }: { configured: boolean; remaining: number | null }) {
  const s = useAssistant();
  const { pathname } = useLocation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [s.messages.length, s.pending]);
  useEffect(() => {
    boxRef.current?.focus();
  }, [s.conversation?.id]);

  const submit = (text: string) => {
    const q = text.trim();
    if (!q || s.pending || !configured) return;
    setDraft('');
    void send(q, pathname, () => {
      void qc.invalidateQueries({ queryKey: ['assistant'] });
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(draft);
    }
  };

  const empty = s.messages.length === 0 && !s.pending && !s.loading;
  const starters = /^\/work-orders\/[^/]+/.test(pathname) ? WO_STARTERS : STARTERS;
  const out = remaining !== null && remaining <= 0;

  return (
    <>
      <div className="asst-body">
        {!configured && (
          <p className="asst-off">
            The assistant is not switched on yet. It starts answering as soon as an Anthropic API key is added to the site’s settings.
          </p>
        )}
        {empty && configured && (
          <div className="asst-empty">
            <p>
              Ask about any work order, quote, payment, vendor or site, or how to do something in The One. Answers are looked up live and only cover what your role lets you see.
            </p>
            <div className="asst-starters">
              {starters.map((q) => (
                <button key={q} type="button" onClick={() => submit(q)} disabled={out}>{q}</button>
              ))}
            </div>
          </div>
        )}
        {s.loading && <p className="asst-wait">Opening…</p>}
        {s.messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="asst-msg is-question">{m.body}</div>
          ) : (
            <Answer key={m.id} m={m} />
          ),
        )}
        {s.pending && (
          <>
            <div className="asst-msg is-question">{s.pending}</div>
            <div className="asst-msg is-answer asst-wait" role="status">
              <span className="asst-dots" aria-hidden="true"><i /><i /><i /></span>
              Looking it up…
            </div>
          </>
        )}
        {s.problem && <p className="asst-problem" role="alert"><Icon name="alert-circle" size={12} />{s.problem}</p>}
        <div ref={endRef} />
      </div>
      <form
        className="asst-compose"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <textarea
          ref={boxRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          maxLength={ASSISTANT_QUESTION_MAX}
          placeholder={out ? 'You have reached today’s limit of questions' : 'Ask a question…'}
          aria-label="Your question"
          disabled={!configured || out}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!configured || out || !!s.pending || draft.trim() === ''} aria-label="Send">
          <Icon name="send" size={14} />
        </button>
      </form>
      {remaining !== null && remaining <= 10 && configured && (
        <p className="asst-foot">{remaining <= 0 ? 'No questions left today. The limit resets at midnight.' : `${remaining} ${remaining === 1 ? 'question' : 'questions'} left today`}</p>
      )}
    </>
  );
}

// ── Earlier conversations ────────────────────────────────────────────────────

const dayText = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function History() {
  const s = useAssistant();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['assistant', 'conversations'], queryFn: listAssistantConversations });
  const remove = useMutation({
    mutationFn: (id: string) => deleteAssistantConversation(id),
    onSuccess: (_r, id) => {
      if (s.conversation?.id === id) set({ conversation: null, messages: [] });
      void qc.invalidateQueries({ queryKey: ['assistant', 'conversations'] });
    },
  });
  const items = list.data?.items ?? [];
  return (
    <div className="asst-body">
      {list.isLoading && <p className="asst-wait">Loading…</p>}
      {list.isError && <p className="asst-problem" role="alert">Your conversations could not be loaded.</p>}
      {!list.isLoading && !list.isError && items.length === 0 && <p className="asst-empty">Nothing asked yet.</p>}
      <ul className="asst-list">
        {items.map((c) => (
          <li key={c.id}>
            <button type="button" className="asst-list-main" onClick={() => void openConversation(c.id)}>
              <span className="asst-list-t">{c.title}</span>
              <span className="asst-list-m">{dayText(c.updated_at)}</span>
            </button>
            <button type="button" className="asst-icon" aria-label={`Delete “${c.title}”`} title="Delete" disabled={remove.isPending} onClick={() => remove.mutate(c.id)}>
              <Icon name="trash" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Teaching ─────────────────────────────────────────────────────────────────

function NoteForm({ note, draft, onClose }: { note: AssistantNote | null; draft: { title: string; body: string } | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(note?.title ?? draft?.title ?? '');
  const [body, setBody] = useState(note?.body ?? draft?.body ?? '');
  const save = useMutation({
    mutationFn: () => saveAssistantNote(note?.id ?? null, { title: title.trim(), body: body.trim(), is_active: note?.is_active ?? true }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['assistant', 'notes'] });
      onClose();
    },
  });
  return (
    <form
      className="asst-noteform"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (title.trim() && body.trim()) save.mutate();
      }}
    >
      <label>
        <span className="lbl">What it is about</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={ASSISTANT_NOTE_TITLE_MAX} placeholder="“Pending vendor”" autoFocus />
      </label>
      <label>
        <span className="lbl">What the assistant should know</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={ASSISTANT_NOTE_BODY_MAX} rows={4} placeholder="When someone says pending vendor they mean the statuses Waiting for Vendor and Vendor Scheduled." />
      </label>
      {save.isError && <p className="asst-problem" role="alert">{errText(save.error, 'The note could not be saved.')}</p>}
      <div className="asst-noteform-f">
        <button type="button" className="btn btn-sm is-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={save.isPending || !title.trim() || !body.trim()}>
          {note ? 'Save' : 'Teach it'}
        </button>
      </div>
    </form>
  );
}

function Notes() {
  const s = useAssistant();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['assistant', 'notes'], queryFn: listAssistantNotes });
  const [editing, setEditing] = useState<AssistantNote | 'new' | null>(s.noteDraft ? 'new' : null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['assistant', 'notes'] });
  const toggle = useMutation({
    mutationFn: (n: AssistantNote) => saveAssistantNote(n.id, { title: n.title, body: n.body, is_active: !n.is_active }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => deleteAssistantNote(id), onSuccess: refresh });
  const close = () => {
    setEditing(null);
    set({ noteDraft: null });
  };
  const items = list.data?.items ?? [];

  return (
    <div className="asst-body">
      <p className="asst-help">
        The assistant reads every note that is switched on before it answers anyone. Use them for how Seamless uses a word, or a rule it got wrong.
      </p>
      {editing ? (
        <NoteForm note={editing === 'new' ? null : editing} draft={editing === 'new' ? s.noteDraft : null} onClose={close} />
      ) : (
        <button type="button" className="btn btn-sm is-ghost asst-add" onClick={() => setEditing('new')}>
          <Icon name="plus" size={14} />Teach it something
        </button>
      )}
      {list.isLoading && <p className="asst-wait">Loading…</p>}
      {list.isError && <p className="asst-problem" role="alert">The notes could not be loaded.</p>}
      <ul className="asst-notes">
        {items.map((n) => (
          <li key={n.id} className={n.is_active ? undefined : 'is-off'}>
            <div className="asst-note-h">
              <strong>{n.title}</strong>
              <span className="asst-note-acts">
                <button type="button" className="asst-icon" aria-label={`Edit “${n.title}”`} title="Edit" onClick={() => setEditing(n)}><Icon name="pencil" size={14} /></button>
                <button type="button" className="asst-icon" aria-label={`Delete “${n.title}”`} title="Delete" disabled={remove.isPending} onClick={() => remove.mutate(n.id)}><Icon name="trash" size={14} /></button>
              </span>
            </div>
            <p>{n.body}</p>
            <label className="asst-switch">
              <input type="checkbox" checked={n.is_active} disabled={toggle.isPending} onChange={() => toggle.mutate(n)} />
              {n.is_active ? 'In use' : 'Switched off'}
              {n.updated_by_name && <span className="asst-list-m"> · {n.updated_by_name}, {dayText(n.updated_at)}</span>}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Review ───────────────────────────────────────────────────────────────────

function ReviewItem({ item }: { item: AssistantFeedbackItem }) {
  const qc = useQueryClient();
  const mark = useMutation({
    mutationFn: (reviewed: boolean) => markAssistantReviewed(item.message_id, reviewed),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['assistant', 'feedback'] }),
  });
  const down = item.feedback === -1;
  return (
    <li className={`asst-review${down ? ' is-down' : ''}${item.reviewed ? ' is-done' : ''}`}>
      <div className="asst-review-h">
        <Icon name={down ? 'thumb-down' : 'thumb-up'} size={14} />
        <span>{item.asked_by}</span>
        <span className="asst-list-m">{dayText(item.feedback_at)}</span>
      </div>
      <p className="asst-review-q">{item.question}</p>
      {item.feedback_note && <p className="asst-review-n">“{item.feedback_note}”</p>}
      <details>
        <summary>The answer{item.lookups.length > 0 ? ` and ${item.lookups.length} look-up${item.lookups.length === 1 ? '' : 's'}` : ''}</summary>
        <Reply body={item.answer} />
        {item.lookups.length > 0 && (
          <ul className="asst-review-l">
            {item.lookups.map((l, i) => <li key={i} className={l.ok ? undefined : 'is-bad'}>{l.summary}</li>)}
          </ul>
        )}
      </details>
      {down && (
        <div className="asst-review-f">
          <button
            type="button"
            className="btn btn-sm is-ghost"
            onClick={() => set({ view: 'notes', noteDraft: { title: item.question.slice(0, ASSISTANT_NOTE_TITLE_MAX), body: '' } })}
          >
            Teach from this
          </button>
          <button type="button" className="btn btn-sm is-ghost" disabled={mark.isPending} onClick={() => mark.mutate(!item.reviewed)}>
            {item.reviewed ? 'Reopen' : 'Mark reviewed'}
          </button>
        </div>
      )}
    </li>
  );
}

function Review() {
  const list = useQuery({ queryKey: ['assistant', 'feedback'], queryFn: getAssistantFeedback });
  const d = list.data;
  return (
    <div className="asst-body">
      <p className="asst-help">
        Answers people marked. A wrong one usually means a word the assistant read differently from how Seamless uses it: teach it a note, then mark the answer reviewed.
      </p>
      {d && <p className="asst-tally">{d.up} marked right · {d.down} marked wrong</p>}
      {list.isLoading && <p className="asst-wait">Loading…</p>}
      {list.isError && <p className="asst-problem" role="alert">The marked answers could not be loaded.</p>}
      {d && d.items.length === 0 && <p className="asst-empty">Nobody has marked an answer yet.</p>}
      <ul className="asst-reviews">{(d?.items ?? []).map((it) => <ReviewItem key={it.message_id} item={it} />)}</ul>
    </div>
  );
}

// ── The panel and its button ─────────────────────────────────────────────────

function Panel() {
  const s = useAssistant();
  const status = useQuery({ queryKey: ['assistant', 'status'], queryFn: getAssistantStatus, staleTime: 30_000 });
  const canTeach = status.data?.can_teach === true;

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') set({ open: false });
    };
    document.addEventListener('keydown', onKey);
    // On a wide screen the page makes room for the panel, so the button a
    // how-to answer points at is not hidden underneath it (assistant.css).
    document.body.classList.add('asst-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('asst-open');
    };
  }, []);

  const tab = (view: View, label: string) => (
    <button type="button" role="tab" aria-selected={s.view === view} className={`asst-tab${s.view === view ? ' is-on' : ''}`} onClick={() => set({ view })}>
      {label}
    </button>
  );

  return createPortal(
    <aside className="asst" role="complementary" aria-label="Assistant">
      <header className="asst-head">
        <span className="asst-title"><Icon name="sparkle" size={16} />Assistant</span>
        <button type="button" className="asst-icon" onClick={newChat} aria-label="New conversation" title="New conversation"><Icon name="plus" size={16} /></button>
        <button type="button" className="asst-icon" onClick={() => set({ open: false })} aria-label="Close the assistant" title="Close (Esc)"><Icon name="x" size={16} /></button>
      </header>
      <div className="asst-tabs" role="tablist">
        {tab('chat', s.conversation ? 'Conversation' : 'Ask')}
        {tab('history', 'Earlier')}
        {canTeach && tab('notes', 'Taught')}
        {canTeach && tab('review', 'Marked answers')}
      </div>
      {s.view === 'chat' && <Chat configured={status.data?.configured !== false} remaining={status.data?.remaining_today ?? null} />}
      {s.view === 'history' && <History />}
      {s.view === 'notes' && canTeach && <Notes />}
      {s.view === 'review' && canTeach && <Review />}
    </aside>,
    document.body,
  );
}

export function AssistantButton() {
  const s = useAssistant();
  return (
    <>
      <button
        type="button"
        className={`topbar-bell asst-btn${s.open ? ' is-on' : ''}`}
        aria-label="Assistant"
        aria-expanded={s.open}
        title="Ask the assistant"
        onClick={() => set({ open: !s.open })}
      >
        <Icon name="sparkle" size={16} />
        {s.pending && !s.open && <span className="asst-btn-dot" aria-hidden="true" />}
      </button>
      {s.open && <Panel />}
    </>
  );
}
