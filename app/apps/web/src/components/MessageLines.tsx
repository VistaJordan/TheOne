/**
 * A message that may carry a list (Elise, 2026-11-16): a refused status move
 * reads "Missing steps to move to X:" followed by one "- " line per step
 * (`missingStepsText` in shared statusGates.ts). Lines starting "- " are drawn
 * as a bulleted list; every other line as plain text. A message with no
 * line breaks renders exactly as the text did before.
 */
export function MessageLines({ text }: { text: string }) {
  if (!text.includes('\n')) return <>{text}</>;
  const blocks: ({ kind: 'text'; text: string } | { kind: 'list'; items: string[] })[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') continue;
    const bullet = /^\s*- (.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (bullet) {
      if (last?.kind === 'list') last.items.push(bullet[1]);
      else blocks.push({ kind: 'list', items: [bullet[1]] });
    } else {
      blocks.push({ kind: 'text', text: line });
    }
  }
  return (
    <span className="msg-lines">
      {blocks.map((b, i) =>
        b.kind === 'list' ? (
          // Spans with list roles, not <ul>: the message often sits in a <p>.
          <span key={i} className="msg-lines-list" role="list">
            {b.items.map((it, j) => (
              <span key={j} className="msg-lines-item" role="listitem">
                {it}
              </span>
            ))}
          </span>
        ) : (
          <span key={i} className="msg-lines-text">
            {b.text}
          </span>
        ),
      )}
    </span>
  );
}
