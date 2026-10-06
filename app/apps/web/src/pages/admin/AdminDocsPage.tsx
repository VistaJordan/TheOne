/* Admin › Documentation (0075).
 *
 * Three living documents on one page — BRD, SOP, Lifecycle — drawn from the
 * registry in packages/shared/src/docs and the live snapshot the API answers
 * (statuses, fields, roles, automations, integrations, migrations). A table
 * of contents rides on the left; Print / Save as PDF uses the browser's print
 * dialog with a print stylesheet; Download gives Markdown, Word (BRD, SOP) or
 * SVG (Lifecycle). Read-only: there is nothing to edit here, the documents
 * change when the system does.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { brdMarkdown, lifecycleMarkdown, sopMarkdown, docsVersionLine, type DocsSnapshot } from '@theone/shared';
import { getDocsSnapshot } from '../../api/client';
import { Icon } from '../../components/Icon';
import { PageTabs, errText } from '../../components/ui/Sheet';
import { BrdDoc, brdToc, type TocEntry } from '../../components/docs/BrdDoc';
import { SopDoc, sopToc } from '../../components/docs/SopDoc';
import { LifecycleChart } from '../../components/docs/LifecycleChart';
import { downloadSvg, downloadText, downloadWord } from '../../components/docs/docsExport';
import { AdminShell } from './AdminShell';

type Tab = 'brd' | 'sop' | 'lifecycle';
const TABS: { id: Tab; label: string }[] = [
  { id: 'brd', label: 'BRD' },
  { id: 'sop', label: 'SOP' },
  { id: 'lifecycle', label: 'Lifecycle' },
];

const stamp = () => new Date().toISOString().slice(0, 10);

export function AdminDocsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'brd') as Tab;
  const q = useQuery({ queryKey: ['admin', 'docs', 'snapshot'], queryFn: getDocsSnapshot, retry: false, staleTime: 60_000 });
  const snap: DocsSnapshot | null = q.data ?? null;
  const paperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const toc = useMemo<TocEntry[]>(() => (tab === 'brd' ? brdToc(snap) : tab === 'sop' ? sopToc() : []), [tab, snap]);
  const [active, setActive] = useState<string | null>(null);

  // Highlight the TOC entry whose heading is nearest the top of the page.
  useEffect(() => {
    if (!toc.length) return;
    const els = toc.map((t) => document.getElementById(t.id)).filter((el): el is HTMLElement => Boolean(el));
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (seen[0]) setActive(seen[0].target.id);
      },
      { rootMargin: '-10% 0px -75% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [toc, snap]);

  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
    window.scrollTo({ top: 0 });
  };

  const name = tab === 'brd' ? 'The-One-BRD' : tab === 'sop' ? 'The-One-SOP' : 'The-One-Work-Order-Lifecycle';
  const title = tab === 'brd' ? 'The One — Business Requirements Document' : tab === 'sop' ? 'The One — Standard Operating Procedures' : 'The One — Work-order lifecycle';

  const onMarkdown = () => {
    const md = tab === 'brd' ? brdMarkdown(snap) : tab === 'sop' ? sopMarkdown(snap) : lifecycleMarkdown(snap);
    downloadText(`${name}-${stamp()}.md`, md);
  };
  const onWord = () => {
    const html = paperRef.current?.innerHTML ?? '';
    downloadWord(`${name}-${stamp()}.doc`, title, html);
  };
  const onSvg = () => {
    if (svgRef.current) downloadSvg(`${name}-${stamp()}.svg`, svgRef.current);
  };
  const onPrint = () => {
    document.body.classList.add('docs-printing');
    const done = () => document.body.classList.remove('docs-printing');
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    setTimeout(done, 2_000);
  };

  return (
    <AdminShell
      title="Documentation"
      subtitle={
        <>
          The living BRD, the SOP and the work-order lifecycle, generated from the registry beside the code and from this instance as it is right now.
          {snap && <> {docsVersionLine(snap)}.</>}
        </>
      }
      actions={
        <div className="docs-actions no-print">
          <PageTabs tabs={TABS} value={tab} onChange={setTab} />
          <div className="docs-buttons">
            <button type="button" className="btn btn-sm" onClick={onPrint} title="Opens the print dialog; choose Save as PDF">
              <Icon name="download" size={12} /> Print / Save as PDF
            </button>
            <button type="button" className="btn btn-sm" onClick={onMarkdown}>
              <Icon name="file" size={12} /> Download Markdown
            </button>
            {tab === 'lifecycle' ? (
              <button type="button" className="btn btn-sm" onClick={onSvg}>
                <Icon name="image" size={12} /> Download SVG
              </button>
            ) : (
              <button type="button" className="btn btn-sm" onClick={onWord}>
                <Icon name="file" size={12} /> Download Word
              </button>
            )}
          </div>
        </div>
      }
    >
      {q.isError && (
        <div className="callout docs-warn no-print" role="alert">
          <Icon name="alert-circle" size={14} />
          <span>The live appendix could not be read ({errText(q.error, 'try again in a moment')}). The written sections are shown; the live tables are not.</span>
        </div>
      )}
      {q.isLoading && (
        <p className="docs-loading no-print">
          <Icon name="refresh" size={12} /> Reading the live instance…
        </p>
      )}

      <div className={`docs-layout${toc.length ? '' : ' is-wide'}`}>
        {toc.length > 0 && (
          <nav className="docs-toc no-print" aria-label="Contents">
            <b className="docs-toc-title">Contents</b>
            <ul>
              {toc.map((t) => (
                <li key={t.id} className={`lvl-${t.level}${active === t.id ? ' is-active' : ''}`}>
                  <a href={`#${t.id}`}>{t.label}</a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className="docs-paper" ref={paperRef}>
          {tab === 'brd' && <BrdDoc snap={snap} />}
          {tab === 'sop' && <SopDoc snap={snap} />}
          {tab === 'lifecycle' && (
            <article className="doc doc-lifecycle">
              <header className="doc-cover">
                <p className="doc-kicker">Work-order lifecycle</p>
                <h1>From the client&rsquo;s system to a paid invoice</h1>
                <p className="doc-sub">Every status by phase, every move, every gate, and the processes that run beside the status line. Click a status for its card.</p>
                <p className="doc-version">{docsVersionLine(snap)}</p>
              </header>
              <LifecycleChart snap={snap} svgRef={svgRef} />
            </article>
          )}
        </div>
      </div>
    </AdminShell>
  );
}
