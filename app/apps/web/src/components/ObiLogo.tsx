import { OBI_LOGO_DAY, OBI_LOGO_NIGHT } from '../lib/brand';

/* The hologram art is drawn on a 300×180 canvas with empty space around it;
   this viewBox frames only the art (beam top to plinth, 2 units of air), so
   the element's own width and height are the logo's. Re-measure if the SVGs
   change: art x 44–256, y 28–159. */
const VIEW_BOX = '42 26 216 135';

/** The OBI logo, day or night art by theme (.obi-logo-day / -night in app.css).
    Size it with CSS on the className given; the aspect ratio is 216:135. */
export function ObiLogo({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      className={['obi-logo', className].filter(Boolean).join(' ')}
      viewBox={VIEW_BOX}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <image className="obi-logo-day" href={OBI_LOGO_DAY} width="300" height="180" />
      <image className="obi-logo-night" href={OBI_LOGO_NIGHT} width="300" height="180" />
    </svg>
  );
}

/* The three letters of the hologram (OBI-hologram-*.svg, same outlines), one
   path each with its own viewBox so they can be spaced by CSS. All 58.8 high. */
const LETTERS = [
  { key: 'O', box: '55.49 45.2 49.56 58.8', d: 'M65.15 104L55.49 94.34L55.49 54.86L65.15 45.2L95.39 45.2L105.05 54.86L105.05 94.34L95.39 104L65.15 104ZM71.2 94.26L89.34 94.26L93.62 89.97L93.62 59.23L89.34 54.94L71.2 54.94L66.91 59.23L66.91 89.97L71.2 94.26Z' },
  { key: 'B', box: '125.13 45.2 47.88 58.8', d: 'M125.13 104L125.13 45.2L162 45.2L170.4 53.6L170.4 70.06L167.04 73.51L173.01 79.56L173.01 94.93L163.94 104L125.13 104ZM136.3 69.81L156.12 69.81L159.15 66.79L159.15 57.72L156.21 54.78L136.3 54.78L136.3 69.81ZM136.3 94.42L158.14 94.42L161.75 90.81L161.75 82.58L158.14 78.97L136.3 78.97L136.3 94.42Z' },
  { key: 'I', box: '191.83 45.2 11.42 58.8', d: 'M191.83 104L191.83 45.2L203.25 45.2L203.25 104L191.83 104Z' },
];

/** The OBI letters alone, solid, for the top bar. Each letter is its own
    <svg> in a flex row (.obi-mark), so the row's width decides the spacing:
    justify-content: space-between spreads them across whatever width CSS
    gives it, while the letters keep their shape at the row's height. Filled
    with currentColor. */
export function ObiWordmark({ className, label = 'OBI' }: { className?: string; label?: string }) {
  return (
    <span className={['obi-mark', className].filter(Boolean).join(' ')} role="img" aria-label={label}>
      {LETTERS.map((l) => (
        <svg key={l.key} viewBox={l.box} aria-hidden="true" focusable="false">
          <path d={l.d} />
        </svg>
      ))}
    </span>
  );
}
