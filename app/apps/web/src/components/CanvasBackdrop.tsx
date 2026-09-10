/* The brand's route, ghosted across every page's canvas — the same waves of
   line-and-bubble stops the sign-in page draws, but toned down to a watermark
   and pinned behind the scrolling canvas so it reads as atmosphere, not
   content. Three waves, each carrying three of the product's stations:
     upper   — work orders → operations manager → vendors
     middle  — quotes → invoicing → payment
     lower   — audit trail → trade → sites
   Each stop sits on a bezier knot of its wave so the bubble reads as a station
   on the line, exactly like the wordmark. Purely decorative; hidden from AT
   and from the pointer. */

import type { IconName } from './Icon';

interface Wave {
  d: string;
  stops: { x: number; y: number; icon: IconName }[];
}

/* viewBox units (1600×1000, scaled to cover). Paths overshoot the edges so a
   wave never visibly starts or ends inside the canvas; stops stay inside
   ~130..870 vertically so `slice` cropping on wide viewports keeps them. */
const WAVES: Wave[] = [
  {
    d: 'M-80 210 C120 250 240 100 460 140 C680 180 760 310 980 270 C1200 230 1280 100 1490 140 C1580 157 1650 200 1720 195',
    stops: [
      { x: 460, y: 140, icon: 'clipboard' },
      { x: 980, y: 270, icon: 'user-cog' },
      { x: 1490, y: 140, icon: 'truck' },
    ],
  },
  {
    d: 'M-80 570 C160 530 300 670 520 630 C740 590 840 430 1060 470 C1280 510 1360 660 1520 625 C1620 603 1680 590 1720 585',
    stops: [
      { x: 520, y: 630, icon: 'file' },
      { x: 1060, y: 470, icon: 'dollar' },
      { x: 1520, y: 625, icon: 'card' },
    ],
  },
  {
    d: 'M-80 880 C160 920 320 770 540 810 C760 850 880 700 1100 740 C1320 780 1400 880 1560 850 C1640 835 1690 820 1720 822',
    stops: [
      { x: 540, y: 810, icon: 'history' },
      { x: 1100, y: 740, icon: 'wrench' },
      { x: 1560, y: 850, icon: 'pin' },
    ],
  },
];

export function CanvasBackdrop() {
  return (
    <svg
      className="canvas-backdrop"
      viewBox="0 0 1600 1000"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      {WAVES.map((wave) => (
        <g key={wave.stops[0].icon}>
          <path className="canvas-backdrop-line" d={wave.d} />
          {wave.stops.map((stop) => (
            <g key={stop.icon} className="canvas-backdrop-stop">
              <circle cx={stop.x} cy={stop.y} r={20} />
              <svg
                className="canvas-backdrop-icon"
                x={stop.x - 10}
                y={stop.y - 10}
                width="20"
                height="20"
                viewBox="0 0 24 24"
              >
                <use href={`#i-${stop.icon}`} />
              </svg>
            </g>
          ))}
        </g>
      ))}
    </svg>
  );
}
