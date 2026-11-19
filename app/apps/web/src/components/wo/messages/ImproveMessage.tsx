/* 0138 · Improve on the Messages composer (Elise, 2026-11-14): Gmail's
 * "Help me write". The person types, opens Improve and picks Polish, More
 * formal, Shorter, Friendlier or writes their own instruction; Claude's
 * rewrite shows above the text box with Replace · Try again · Dismiss.
 * Nothing is posted until they post it the ordinary way.
 *
 * The model, the daily limit and the monthly budget are Dashboard › AI usage's.
 * The button is not drawn while AI is switched off or not set up, and is
 * drawn locked with the reason once a limit or the budget is reached.
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AI_IMPROVE_INSTRUCTION_MAX, AI_IMPROVE_MODES, AI_IMPROVE_MODE_LABELS, AI_OFF_CODE } from '@theone/shared';
import type { AiImproveMode } from '@theone/shared';
import { getAiStatus, improveWorkOrderMessage } from '../../../api/client';
import { Icon } from '../../Icon';

const MODE_HINTS: Record<AiImproveMode, string> = {
  polish: 'Fix spelling and grammar, read clearly',
  formal: 'Professional tone',
  shorter: 'Same facts, fewer words',
  friendlier: 'Warmer, still professional',
  custom: 'Say how to change it',
};

interface Ask {
  body: string;
  mode: AiImproveMode;
  instruction?: string;
}

export interface ImproveSuggestionState {
  text: string;
  label: string;
}

/** The request, its result and the last ask (for Try again). */
export function useImproveMessage(woId: string, clientVisible: boolean) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['ai', 'status'], queryFn: getAiStatus, staleTime: 60_000, retry: 0 });
  const [last, setLast] = useState<Ask | null>(null);
  const [suggestion, setSuggestion] = useState<ImproveSuggestionState | null>(null);
  const mutation = useMutation({
    mutationFn: (ask: Ask) => improveWorkOrderMessage(woId, { ...ask, client_visible: clientVisible }),
    onMutate: (ask) => {
      setLast(ask);
      setSuggestion(null);
    },
    onSuccess: (res, ask) => {
      const label = ask.mode === 'custom' ? 'Custom' : AI_IMPROVE_MODE_LABELS[ask.mode];
      setSuggestion({ text: res.text, label });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['ai', 'status'] }),
  });
  const state = status.data?.message_improve;
  return {
    /** Hidden: AI is off or not set up (or the status could not be read). */
    hidden: !state || state.code === AI_OFF_CODE,
    locked: state && !state.available ? state.reason : null,
    run: (ask: Ask) => mutation.mutate(ask),
    retry: () => last && mutation.mutate(last),
    dismiss: () => {
      setSuggestion(null);
      mutation.reset();
    },
    busy: mutation.isPending,
    error: mutation.isError ? (mutation.error as Error).message || 'The AI could not improve the message.' : null,
    suggestion,
  };
}

type Improve = ReturnType<typeof useImproveMessage>;

/** The ✨ Improve button and its menu, in the composer's tool row. */
export function ImproveButton({ improve, body }: { improve: Improve; body: string }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [instruction, setInstruction] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (improve.hidden) return null;
  const text = body.trim();
  const title = improve.locked ?? (text ? 'Improve this message with AI' : 'Type a message first, then improve it');

  const go = (mode: AiImproveMode) => {
    if (mode === 'custom') {
      setCustom(true);
      return;
    }
    setOpen(false);
    improve.run({ body: text, mode });
  };
  const goCustom = () => {
    const how = instruction.trim();
    if (!how) return;
    setOpen(false);
    setCustom(false);
    improve.run({ body: text, mode: 'custom', instruction: how });
  };

  return (
    <div className="ai-improve" ref={ref}>
      <button
        type="button"
        className="tool-btn ai-improve-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!text || Boolean(improve.locked) || improve.busy}
        title={title}
        onClick={() => {
          setCustom(false);
          setOpen((o) => !o);
        }}
      >
        <Icon name="sparkle" size={14} />
        <span>{improve.busy ? 'Improving…' : 'Improve'}</span>
      </button>
      {open && (
        <div className="ai-improve-pop" role="menu" aria-label="Improve the message">
          {!custom ? (
            AI_IMPROVE_MODES.map((mode) => (
              <button key={mode} type="button" role="menuitem" className="ai-improve-item" onClick={() => go(mode)}>
                <b>{AI_IMPROVE_MODE_LABELS[mode]}</b>
                <small>{MODE_HINTS[mode]}</small>
              </button>
            ))
          ) : (
            <form
              className="ai-improve-custom"
              onSubmit={(e) => {
                e.preventDefault();
                goCustom();
              }}
            >
              <label htmlFor="ai-improve-how">How should it change?</label>
              <input
                id="ai-improve-how"
                className="fld"
                autoFocus
                maxLength={AI_IMPROVE_INSTRUCTION_MAX}
                placeholder="What should change?"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
              <div className="ai-improve-custom-foot">
                <button type="button" className="btn" onClick={() => setCustom(false)}>Back</button>
                <button type="submit" className="btn btn-primary" disabled={!instruction.trim()}>Rewrite</button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

/** Claude's rewrite, above the text box. */
export function ImproveSuggestion({ improve, onReplace }: { improve: Improve; onReplace: (text: string) => void }) {
  if (improve.busy) {
    return (
      <div className="ai-suggest is-busy" role="status">
        <Icon name="sparkle" size={12} /> Writing a suggestion…
      </div>
    );
  }
  if (improve.error) {
    return (
      <div className="ai-suggest is-error" role="alert">
        <span><Icon name="alert-circle" size={12} /> {improve.error}</span>
        <button type="button" className="btn" onClick={improve.dismiss}>Dismiss</button>
      </div>
    );
  }
  if (!improve.suggestion) return null;
  return (
    <div className="ai-suggest" aria-label="AI suggestion">
      <div className="ai-suggest-head">
        <Icon name="sparkle" size={12} />
        <b>Suggestion</b>
        <span className="ai-suggest-mode">{improve.suggestion.label}</span>
        <span className="ai-suggest-note">Check it before you post — AI can make mistakes</span>
      </div>
      <p className="ai-suggest-text">{improve.suggestion.text}</p>
      <div className="ai-suggest-foot">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            onReplace(improve.suggestion!.text);
            improve.dismiss();
          }}
        >
          Replace
        </button>
        <button type="button" className="btn" onClick={improve.retry}>Try again</button>
        <button type="button" className="btn" onClick={improve.dismiss}>Dismiss</button>
      </div>
    </div>
  );
}
