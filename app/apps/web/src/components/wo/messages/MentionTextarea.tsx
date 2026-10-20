import { useId, useRef, useState } from 'react';
import type { KeyboardEvent, TextareaHTMLAttributes } from 'react';
import { useQuery } from '@tanstack/react-query';
import { activeMentionQuery, filterMentionCandidates } from '@theone/shared';
import type { MentionCandidate } from '../../../api/client';
import { getMentionCandidates } from '../../../api/client';
import { initials } from '../../../lib/fields';

interface MentionTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string;
  onChange: (value: string) => void;
  /** Who the @ list offers (GET …/mention-candidates). */
  candidates: readonly MentionCandidate[];
  /** Called with the person picked; the caller keeps the list. */
  onMention: (person: MentionCandidate) => void;
}

/** 0089 · who the @ list offers on one work order. Shared by the composer
    and the edit box, so it is fetched once per work order. */
export function useMentionCandidates(woId: string, enabled: boolean): MentionCandidate[] {
  const q = useQuery({
    queryKey: ['wo-mention-candidates', woId],
    queryFn: () => getMentionCandidates(woId),
    enabled,
    staleTime: 5 * 60_000,
    retry: 0,
  });
  return q.data?.items ?? [];
}

/** 0089 · a textarea with ClickUp's @ list: typing "@" and a few letters opens
    the people who can open this work order; ↑ ↓ move, Enter or Tab picks,
    Esc closes. Picking writes "@Display Name " into the text and hands the
    person to `onMention` — the API keeps them only while that name is still
    in the body. */
export function MentionTextarea({ value, onChange, candidates, onMention, onKeyDown, ...rest }: MentionTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  const q = caret === null ? null : activeMentionQuery(value, caret);
  const open = q !== null && q.start !== dismissedAt && candidates.length > 0;
  const matches = q ? filterMentionCandidates(candidates, q.query) : [];
  const showList = open && matches.length > 0;
  const activeIdx = Math.min(active, Math.max(0, matches.length - 1));

  const syncCaret = () => setCaret(ref.current?.selectionStart ?? null);

  const pick = (person: MentionCandidate) => {
    if (!q) return;
    const insert = `@${person.name} `;
    const end = q.start + 1 + q.query.length;
    const next = value.slice(0, q.start) + insert + value.slice(end);
    const pos = q.start + insert.length;
    onChange(next);
    onMention(person);
    setActive(0);
    setCaret(pos);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showList) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((activeIdx + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((activeIdx - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(matches[activeIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedAt(q?.start ?? null);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <div className="mention-wrap">
      <textarea
        {...rest}
        ref={ref}
        value={value}
        role="combobox"
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={showList ? `${listId}-${activeIdx}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart);
          setActive(0);
          if (dismissedAt !== null) {
            const nq = activeMentionQuery(e.target.value, e.target.selectionStart);
            if (!nq || nq.start !== dismissedAt) setDismissedAt(null);
          }
        }}
        onKeyDown={keyDown}
        onKeyUp={(e) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) syncCaret();
        }}
        onClick={syncCaret}
        onBlur={() => setCaret(null)}
      />
      {showList && (
        <ul className="mention-list" id={listId} role="listbox" aria-label="People to mention">
          {matches.map((c, i) => (
            <li
              key={c.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIdx}
              className={`mention-opt${i === activeIdx ? ' is-active' : ''}`}
              // mousedown, not click: a click would blur the textarea first.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="mention-av" aria-hidden="true">{initials(c.name)}</span>
              <span className="mention-name">{c.name}</span>
              {c.role_label && <span className="mention-role">{c.role_label}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
