/* The route at the sidebar's empty foot — a winding line with department
   stops, drawn the way the wordmark draws its own: a flowing S-curve rather
   than a knot, with solid sky-blue bubbles (the active nav item's colours)
   carrying one icon per department. A short companion line keeps the right
   edge company. Purely decorative; hidden from AT, from the pointer, from
   the collapsed rail and from short viewports (see .side-scribble in
   app.css). */

import type { IconName } from './Icon';

/* viewBox units — 232 wide (the expanded rail) by 340 tall. Both lines
   overshoot an edge so they read as passing through, not framed. Every stop
   sits on a bezier knot of its line, like the wordmark's. */
const LINES = [
  'M-10 45 C40 20 85 25 115 55 C145 85 120 120 80 140 C45 158 45 195 85 210 C125 225 165 200 190 225 C215 250 195 285 150 292 C110 299 78 315 68 348',
  'M245 100 C195 115 160 145 175 175 C190 205 228 208 245 232',
];

const STOPS: { x: number; y: number; icon: IconName }[] = [
  { x: 115, y: 55, icon: 'grid' },
  { x: 80, y: 140, icon: 'clipboard' },
  { x: 175, y: 175, icon: 'sliders' },
  { x: 85, y: 210, icon: 'truck' },
  { x: 190, y: 225, icon: 'file' },
  { x: 150, y: 292, icon: 'dollar' },
];

export function SidebarScribble() {
  return (
    <svg
      className="side-scribble"
      viewBox="0 0 232 340"
      preserveAspectRatio="xMidYMax meet"
      aria-hidden="true"
      focusable="false"
    >
      {LINES.map((d) => (
        <path key={d} className="side-scribble-line" d={d} />
      ))}
      {STOPS.map((stop) => (
        <g key={stop.icon} className="side-scribble-stop">
          {/* Two fills: --side-bg underneath punches the line's gap even in
              night, where the sky tint on top is translucent. */}
          <circle className="side-scribble-punch" cx={stop.x} cy={stop.y} r={12} />
          <circle className="side-scribble-tint" cx={stop.x} cy={stop.y} r={12} />
          <svg
            className="side-scribble-icon"
            x={stop.x - 6}
            y={stop.y - 6}
            width="12"
            height="12"
            viewBox="0 0 24 24"
          >
            <use href={`#i-${stop.icon}`} />
          </svg>
        </g>
      ))}
    </svg>
  );
}
