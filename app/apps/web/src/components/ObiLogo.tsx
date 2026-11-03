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

