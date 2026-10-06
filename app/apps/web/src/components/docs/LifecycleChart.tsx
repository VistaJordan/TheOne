/* 0075 · The work-order lifecycle as a chart.

   Columns are the lifecycle phases (PHASE_ORDER) plus an off-ramp column;
   each status is a node in its phase's column, coloured like its pill, with
   the live count from the snapshot, a lock when a gate guards it and the
   Ecotrak status it would push. Arrows are the moves in LIFECYCLE.edges,
   styled by kind. Click a node for its card: meaning, how it is entered,
   who moves it, what the system does on entry, the gate, the side processes
   attached to it. Under the chart, the stages strip and the side-process
   cards. Everything is one SVG so it prints and downloads as a picture. */

import { useMemo, useState, type RefObject } from 'react';
import {
  ECOTRAK_PUSH_BY_STATUS_NAME,
  LIFECYCLE,
  PHASE_BY_STATUS_NAME,
  PHASE_ORDER,
  describeStatusGate,
  type DocsSnapshot,
  type LifecycleEdgeKind,
  type LifecycleNode,
} from '@theone/shared';
import { Icon } from '../Icon';

const COL_W = 176;
const COL_GAP = 16;
const NODE_W = 160;
const NODE_H = 54;
const ROW_GAP = 34;
const TOP = 64;
const LEFT = 16;
const OFFRAMP = 'Off-ramp';

const EDGE_CLASS: Record<LifecycleEdgeKind, string> = {
  main: 'lc-edge-main',
  system: 'lc-edge-system',
  branch: 'lc-edge-branch',
  exception: 'lc-edge-exception',
};

interface Placed {
  node: LifecycleNode;
  col: number;
  row: number;
  x: number;
  y: number;
}

function layout(): { cols: string[]; placed: Placed[]; width: number; height: number } {
  const cols = [...PHASE_ORDER, OFFRAMP];
  const rowsPerCol = new Map<number, number>();
  const placed: Placed[] = LIFECYCLE.nodes.map((node) => {
    const phase = PHASE_BY_STATUS_NAME[node.status] ?? null;
    const col = phase ? cols.indexOf(phase) : cols.length - 1;
    const row = rowsPerCol.get(col) ?? 0;
    rowsPerCol.set(col, row + 1);
    return { node, col, row, x: LEFT + col * (COL_W + COL_GAP) + (COL_W - NODE_W) / 2, y: TOP + row * (NODE_H + ROW_GAP) };
  });
  const maxRows = Math.max(...rowsPerCol.values(), 1);
  return {
    cols,
    placed,
    width: LEFT * 2 + cols.length * (COL_W + COL_GAP) - COL_GAP,
    height: TOP + maxRows * (NODE_H + ROW_GAP) + 10,
  };
}

function edgePath(a: Placed, b: Placed): string {
  if (a.col === b.col) {
    // Same column: a curve out to the right and back.
    const x = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const y2 = b.y + NODE_H / 2;
    const bulge = 36;
    return `M ${x} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${x} ${y2}`;
  }
  const forward = b.col > a.col;
  const x1 = forward ? a.x + NODE_W : a.x;
  const x2 = forward ? b.x : b.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const y2 = b.y + NODE_H / 2;
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + (forward ? dx : -dx)} ${y1}, ${x2 - (forward ? dx : -dx)} ${y2}, ${x2} ${y2}`;
}

function shortLabel(s: string): string {
  return s.length > 24 ? `${s.slice(0, 23)}…` : s;
}

export function LifecycleChart({ snap, svgRef }: { snap: DocsSnapshot | null; svgRef: RefObject<SVGSVGElement> }) {
  const { cols, placed, width, height } = useMemo(layout, []);
  const byStatus = useMemo(() => new Map(placed.map((p) => [p.node.status, p])), [placed]);
  const live = useMemo(() => new Map((snap?.statuses ?? []).map((s) => [s.name, s])), [snap]);
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const focus = picked ?? hover;
  const pickedNode = picked ? byStatus.get(picked)?.node ?? null : null;
  const relatedSide = picked ? LIFECYCLE.side.filter((s) => s.statuses.includes(picked)) : [];
  const edgesIn = picked ? LIFECYCLE.edges.filter((e) => e.to === picked) : [];
  const edgesOut = picked ? LIFECYCLE.edges.filter((e) => e.from === picked) : [];

  return (
    <div className="lc">
      <div className="lc-legend no-print-hide">
        {(Object.keys(LIFECYCLE.legend) as LifecycleEdgeKind[]).map((k) => (
          <span key={k} className={`lc-legend-item ${EDGE_CLASS[k]}`}>
            <svg width="34" height="10" aria-hidden="true">
              <path d="M 1 5 L 33 5" className={EDGE_CLASS[k]} markerEnd={`url(#lc-arrow-${k})`} />
            </svg>
            <b>{k === 'main' ? 'Usual path' : k === 'system' ? 'System move' : k === 'branch' ? 'Branch' : 'Exception'}</b>
            <small>{LIFECYCLE.legend[k]}</small>
          </span>
        ))}
        <span className="lc-legend-item">
          <Icon name="lock" size={12} />
          <b>Gate</b>
          <small>The status is refused until the record is ready.</small>
        </span>
      </div>

      <div className="lc-scroll">
        <svg ref={svgRef} className="lc-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Work-order lifecycle: statuses by phase with the moves between them">
          <defs>
            {(Object.keys(EDGE_CLASS) as LifecycleEdgeKind[]).map((k) => (
              <marker key={k} id={`lc-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className={`lc-arrowhead ${EDGE_CLASS[k]}`} />
              </marker>
            ))}
          </defs>

          {/* Phase columns */}
          {cols.map((c, i) => {
            const x = LEFT + i * (COL_W + COL_GAP);
            return (
              <g key={c} className={`lc-col${c === OFFRAMP ? ' is-offramp' : ''}`}>
                <rect x={x} y={TOP - 30} width={COL_W} height={height - TOP + 20} rx={12} className="lc-col-bg" />
                <text x={x + COL_W / 2} y={TOP - 10} textAnchor="middle" className="lc-col-title">
                  {c}
                </text>
              </g>
            );
          })}

          {/* Edges */}
          {LIFECYCLE.edges.map((e, i) => {
            const a = byStatus.get(e.from);
            const b = byStatus.get(e.to);
            if (!a || !b) return null;
            const dim = focus && e.from !== focus && e.to !== focus;
            const d = edgePath(a, b);
            return (
              <g key={i} className={`lc-edge ${EDGE_CLASS[e.kind]}${dim ? ' is-dim' : ''}${focus && !dim ? ' is-lit' : ''}`}>
                <path d={d} markerEnd={`url(#lc-arrow-${e.kind})`} />
                {e.label && focus && !dim && (
                  <text className="lc-edge-label">
                    <textPath href={`#lc-path-${i}`} startOffset="50%" textAnchor="middle">
                      {e.label}
                    </textPath>
                  </text>
                )}
                <path id={`lc-path-${i}`} d={d} fill="none" stroke="none" />
              </g>
            );
          })}

          {/* Nodes */}
          {placed.map((p) => {
            const s = live.get(p.node.status);
            const color = s?.color ?? 'var(--ink-3)';
            const push = ECOTRAK_PUSH_BY_STATUS_NAME[p.node.status] ?? [];
            const dim = focus && focus !== p.node.status && !LIFECYCLE.edges.some((e) => (e.from === focus && e.to === p.node.status) || (e.to === focus && e.from === p.node.status));
            return (
              <g
                key={p.node.status}
                className={`lc-node${picked === p.node.status ? ' is-picked' : ''}${dim ? ' is-dim' : ''}`}
                transform={`translate(${p.x} ${p.y})`}
                onMouseEnter={() => setHover(p.node.status)}
                onMouseLeave={() => setHover(null)}
                onClick={() => setPicked(picked === p.node.status ? null : p.node.status)}
                role="button"
                tabIndex={0}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') setPicked(picked === p.node.status ? null : p.node.status);
                }}
              >
                <rect width={NODE_W} height={NODE_H} rx={10} className="lc-node-bg" />
                <rect width={5} height={NODE_H} rx={2.5} fill={color} />
                <text x={14} y={21} className="lc-node-title">
                  {shortLabel(p.node.status)}
                </text>
                <text x={14} y={40} className="lc-node-sub">
                  {push.length ? `Ecotrak → ${push.join(' → ')}` : s ? 'no Ecotrak push' : ''}
                </text>
                {s && (
                  <g transform={`translate(${NODE_W - 12} 12)`}>
                    <circle r={11} className="lc-count-bg" />
                    <text textAnchor="middle" y={4} className="lc-count">
                      {s.wo_count > 999 ? '999+' : s.wo_count}
                    </text>
                  </g>
                )}
                {p.node.gate && (
                  <g transform={`translate(${NODE_W - 12} ${NODE_H - 13})`} className="lc-gate">
                    <circle r={9} className="lc-gate-bg" />
                    <path d="M -3 -0.5 h 6 v 4 h -6 z M -2 -0.5 v -2 a 2 2 0 0 1 4 0 v 2" className="lc-gate-icon" />
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Detail card */}
      {pickedNode && (
        <section className="card lc-detail">
          <div className="card-head">
            <h3 className="card-title">
              <span className="doc-status">
                <i style={{ background: live.get(pickedNode.status)?.color ?? 'var(--ink-3)' }} /> {pickedNode.status}
              </span>
              {live.has(pickedNode.status) && <span className="chip chip-sm">{live.get(pickedNode.status)!.wo_count} live</span>}
              <span className="chip chip-sm">{PHASE_BY_STATUS_NAME[pickedNode.status] ?? 'Off-ramp'}</span>
            </h3>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(null)}>
              <Icon name="x" size={12} /> Close
            </button>
          </div>
          <div className="lc-detail-grid">
            <div>
              <h4>What it means</h4>
              <p>{pickedNode.meaning}</p>
              <h4>How a work order gets here</h4>
              <p>{pickedNode.enteredBy}</p>
              <h4>Who moves it</h4>
              <p>{pickedNode.who}</p>
              {pickedNode.gate && (
                <>
                  <h4>
                    <Icon name="lock" size={12} /> Gate
                  </h4>
                  <p>{describeStatusGate(pickedNode.gate, pickedNode.status, pickedNode.gate === "done" ? ["visit", "cost", "quote", "after_photo"] : undefined)}</p>
                </>
              )}
            </div>
            <div>
              {pickedNode.onEnter?.length ? (
                <>
                  <h4>What the system does on entry</h4>
                  <ul>
                    {pickedNode.onEnter.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              <h4>Moves</h4>
              <ul className="lc-moves">
                {edgesIn.map((e, i) => (
                  <li key={`in-${i}`}>
                    <span className={`lc-dot ${EDGE_CLASS[e.kind]}`} /> from <b>{e.from}</b>
                    {e.label ? ` · ${e.label}` : ''}
                  </li>
                ))}
                {edgesOut.map((e, i) => (
                  <li key={`out-${i}`}>
                    <span className={`lc-dot ${EDGE_CLASS[e.kind]}`} /> to <b>{e.to}</b>
                    {e.label ? ` · ${e.label}` : ''}
                  </li>
                ))}
              </ul>
              {relatedSide.length ? (
                <>
                  <h4>Runs beside it</h4>
                  <ul>
                    {relatedSide.map((s) => (
                      <li key={s.key}>
                        <a href={`#lc-side-${s.key}`}>{s.title}</a>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          </div>
        </section>
      )}

      {/* Stages strip */}
      <section className="lc-stages">
        <h3>The stages</h3>
        <ol className="lc-stage-list">
          {LIFECYCLE.stages.map((st, i) => (
            <li key={st.key} className="lc-stage">
              <span className="lc-stage-n">{i + 1}</span>
              <div>
                <b>{st.title}</b>
                <small>{st.who.join(' · ')}</small>
                <p>{st.summary}</p>
                {st.phases.length > 0 && (
                  <p className="lc-stage-phases">
                    {st.phases.map((ph) => (
                      <span key={ph} className="chip chip-sm">
                        {ph}
                      </span>
                    ))}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Side processes */}
      <section className="lc-side">
        <h3>What runs beside the statuses</h3>
        <p className="doc-lead">The processes that attach to a status without being one: acceptance, finding the technician, visits, the quote clock, requests, money, photos, invoicing, the client, the flags.</p>
        <div className="lc-side-grid">
          {LIFECYCLE.side.map((s) => (
            <article key={s.key} id={`lc-side-${s.key}`} className={`card lc-side-card${picked && s.statuses.includes(picked) ? ' is-lit' : ''}`}>
              <div className="card-head">
                <h4 className="card-title">{s.title}</h4>
                {s.brd?.length ? <span className="card-meta">rules {s.brd.join(', ')}</span> : null}
              </div>
              <p className="lc-side-summary">{s.summary}</p>
              <ul>
                {s.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
              <p className="lc-side-statuses">
                {s.statuses.map((st) => (
                  <button key={st} type="button" className={`chip chip-sm lc-chip${picked === st ? ' is-on' : ''}`} onClick={() => setPicked(st)}>
                    <i style={{ background: live.get(st)?.color ?? 'var(--ink-3)' }} /> {st}
                  </button>
                ))}
              </p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
