/* 0075 · The SOP, in the Tech Locator Map SOPs format: document control, role
   purpose, scope, who can use it, table of contents, definitions, SOP n
   sections with steps / notes / tables, who does what, success metric,
   revision history (the migration ledger) and sign-off. */

import { SOP, docsVersionLine, type DocsSnapshot, type SopBlock } from '@theone/shared';
import { DocBox, DocTable, Rich, fmtDate } from './DocBits';
import type { TocEntry } from './BrdDoc';

export function sopToc(): TocEntry[] {
  const toc: TocEntry[] = [
    { id: 'sop-purpose', label: 'Role Purpose', level: 1 },
    { id: 'sop-scope', label: 'Scope', level: 1 },
    { id: 'sop-terms', label: 'Definitions', level: 1 },
  ];
  for (const p of SOP.procedures) toc.push({ id: `sop-${p.n}`, label: `SOP ${p.n}: ${p.title}`, level: 2 });
  toc.push({ id: 'sop-matrix', label: 'Who does what', level: 1 });
  toc.push({ id: 'sop-metric', label: 'Main success metric', level: 1 });
  toc.push({ id: 'sop-history', label: 'Revision history', level: 1 });
  toc.push({ id: 'sop-signoff', label: 'Sign-off', level: 1 });
  return toc;
}

function Block({ b }: { b: SopBlock }) {
  switch (b.kind) {
    case 'p':
      return (
        <p>
          <Rich text={b.text} />
        </p>
      );
    case 'sub':
      return <h4 className="sop-sub">{b.title}</h4>;
    case 'steps':
      return (
        <ol className="sop-steps">
          {b.items.map((it, i) => (
            <li key={i}>
              <Rich text={it} />
            </li>
          ))}
        </ol>
      );
    case 'bullets':
      return (
        <ul className="sop-bullets">
          {b.items.map((it, i) => (
            <li key={i}>
              <Rich text={it} />
            </li>
          ))}
        </ul>
      );
    case 'table':
      return <DocTable head={b.head} rows={b.rows.map((r) => r.map((c, i) => <Rich key={i} text={c} />))} />;
    case 'note':
      return (
        <DocBox title={b.title}>
          <Rich text={b.text} />
        </DocBox>
      );
  }
}

export function SopDoc({ snap }: { snap: DocsSnapshot | null }) {
  return (
    <article className="doc doc-sop">
      <header className="doc-cover">
        <p className="doc-kicker">Standard Operating Procedures</p>
        <h1>{SOP.title.replace(/^The One — /, '')}</h1>
        <p className="doc-sub">{SOP.subtitle}</p>
        <p className="doc-version">{docsVersionLine(snap)}</p>
        <DocBox title="Document control">{SOP.control}</DocBox>
      </header>

      <section id="sop-purpose">
        <h2>Role Purpose</h2>
        {SOP.purpose.map((p, i) => (
          <p key={i} className={i === SOP.purpose.length - 1 ? 'doc-lead' : undefined}>
            {p}
          </p>
        ))}
      </section>

      <section id="sop-scope">
        <h2>Scope</h2>
        <p>{SOP.scope}</p>
        <DocBox title="WHO CAN USE IT">{SOP.whoCanUse}</DocBox>
      </section>

      <section id="sop-toc">
        <h2>Table of Contents for SOPs</h2>
        <ol className="sop-toc">
          {SOP.procedures.map((p) => (
            <li key={p.n}>
              <a href={`#sop-${p.n}`}>
                SOP {p.n}: {p.title}
              </a>
            </li>
          ))}
        </ol>
      </section>

      <section id="sop-terms">
        <h2>Definitions of Technical Terms</h2>
        <DocTable head={['Term', 'Definition']} rows={SOP.terms.map((t) => [<b key="t">{t.term}</b>, t.definition])} />
      </section>

      {SOP.procedures.map((p) => (
        <section key={p.n} id={`sop-${p.n}`} className="sop-proc">
          <h2>
            SOP {p.n}: {p.title}
          </h2>
          <p className="doc-lead">{p.lead}</p>
          <p className="doc-meta sop-meta">
            <span>
              <b>Who</b> {p.who.join(', ')}
            </span>
            <span>
              <b>Where</b> {p.where}
            </span>
            {p.needs.length ? (
              <span>
                <b>Needs</b>{' '}
                {p.needs.map((n) => (
                  <code key={n}>{n}</code>
                ))}
              </span>
            ) : null}
          </p>
          {p.blocks.map((b, i) => (
            <Block key={i} b={b} />
          ))}
        </section>
      ))}

      <section id="sop-matrix">
        <h2>Who Does What</h2>
        <DocTable head={['Role', 'Procedures']} rows={SOP.matrix.map((m) => [<b key="r">{m.role}</b>, m.procedures.map((n) => `SOP ${n}`).join(', ')])} />
      </section>

      <section id="sop-metric">
        <h2>Main Success Metric</h2>
        <p>{SOP.successMetric}</p>
      </section>

      <section id="sop-history">
        <h2>Review and Revision History</h2>
        <p className="doc-lead">Drawn from the migration ledger: every change to the schema and the seeded configuration, newest first.</p>
        {snap ? (
          <DocTable
            head={['Version', 'Date', 'Revision description', 'Status']}
            rows={snap.migrations
              .slice()
              .reverse()
              .map((m) => [String(m.n).padStart(4, '0'), fmtDate(m.applied_at), m.title, 'Applied'])}
          />
        ) : (
          <p>The migration ledger could not be read.</p>
        )}
      </section>

      <section id="sop-signoff">
        <h2>Document Sign-Off</h2>
        <p>This section is completed when the SOP is presented for internal use and reviewed by management.</p>
        <DocTable
          className="sop-signoff"
          head={['Approval type', 'Name', 'Title / Department', 'Signature', 'Date']}
          rows={[
            ['Presented By', '', '', '', ''],
            ['Reviewed By', '', '', '', ''],
          ]}
        />
      </section>
    </article>
  );
}
