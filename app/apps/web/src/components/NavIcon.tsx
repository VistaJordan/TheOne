/* Sidebar icons, drawn inline rather than through the sprite.

   <Icon> references a <symbol> with <use>, and nothing in the document can
   reach the parts of a <use> clone — so ".side-item:hover .line" never
   matches. The primary-nav icons are drawn here as real elements instead,
   with a class on each moving part, so app.css can give every item a small
   hover animation that says what the item does:

     grid       tiles pop in one after another
     zap        the heartbeat traces itself in, left to right
     clipboard  the clip snaps down and the two lines tick in
     truck      the truck rolls forward with a bump
     file       the text lines write themselves in
     dollar     the coin flips
     card       the signature strip writes itself in
     inbox      the tray's lip writes itself in
     sliders    the knobs slide

   Paths are copied verbatim from the sprite, so the icons look identical at
   rest. Any other name falls back to the sprite. */

import { Icon, type IconName } from './Icon';

type NavIconSize = 16 | 18;

interface NavIconProps {
  name: IconName;
  size?: NavIconSize;
}

export function NavIcon({ name, size = 18 }: NavIconProps) {
  const inline = DRAWINGS[name];
  if (!inline) return <Icon name={name} size={size} />;
  const cls = ['ic', size === 16 ? '' : `ic-${size}`, 'ni', `ni-${name}`].filter(Boolean).join(' ');
  return (
    <svg className={cls} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {inline}
    </svg>
  );
}

const DRAWINGS: Partial<Record<IconName, JSX.Element>> = {
  grid: (
    <>
      <rect className="ni-tile" x="3" y="3" width="7" height="7" rx="1" />
      <rect className="ni-tile" x="14" y="3" width="7" height="7" rx="1" />
      <rect className="ni-tile" x="3" y="14" width="7" height="7" rx="1" />
      <rect className="ni-tile" x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  zap: (
    /* The sprite draws this right-to-left; reversed here so the trace runs
       the way a monitor sweeps. Same points, same picture at rest. */
    <polyline className="ni-beat" points="2 12 6 12 9 3 15 21 18 12 22 12" pathLength={1} />
  ),
  clipboard: (
    <>
      <path className="ni-clip" d="M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1Z" />
      <path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" />
      <line className="ni-line" x1="8" y1="11" x2="16" y2="11" pathLength={1} />
      <line className="ni-line" x1="8" y1="15" x2="13" y2="15" pathLength={1} />
    </>
  ),
  truck: (
    <g className="ni-truck">
      <path d="M3 6h11v9H3z" />
      <path d="M14 9h4l3 3v3h-7z" />
      <circle className="ni-wheel" cx="7" cy="18" r="2" />
      <circle className="ni-wheel" cx="17" cy="18" r="2" />
    </g>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <line className="ni-line" x1="9" y1="13" x2="15" y2="13" pathLength={1} />
      <line className="ni-line" x1="9" y1="17" x2="13" y2="17" pathLength={1} />
    </>
  ),
  dollar: (
    <g className="ni-coin">
      <line x1="12" y1="2" x2="12" y2="22" />
      <path d="M17 5.5H9.8a3.3 3.3 0 0 0 0 6.6h4.4a3.3 3.3 0 0 1 0 6.6H6" />
    </g>
  ),
  card: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <line x1="2.5" y1="10" x2="21.5" y2="10" />
      <line className="ni-swipe" x1="6.5" y1="15" x2="10" y2="15" pathLength={1} />
    </>
  ),
  inbox: (
    <>
      <path d="M5.5 5.1 3.3 11.3A2 2 0 0 0 3 12v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-.3-.7L18.5 5.1A2 2 0 0 0 16.6 4H7.4a2 2 0 0 0-1.9 1.1Z" />
      <polyline className="ni-line" points="3 12 8 12 9.5 15 14.5 15 16 12 21 12" pathLength={1} />
    </>
  ),
  sliders: (
    <>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line className="ni-knob" x1="1.5" y1="14" x2="6.5" y2="14" />
      <line className="ni-knob" x1="9.5" y1="8" x2="14.5" y2="8" />
      <line className="ni-knob" x1="17.5" y1="16" x2="22.5" y2="16" />
    </>
  ),
};
