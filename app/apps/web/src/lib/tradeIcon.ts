import type { IconName } from '../components/Icon';

/** The glyph for a trade, shared by the list's trade cells and the detail
    page's knob. Trade is a founder-editable dropdown, so match on substrings
    and fall back to a neutral tag for any value we have no glyph for. */
export function tradeIcon(trade: string): IconName {
  const t = trade.toLowerCase();
  if (t.includes('plumb')) return 'droplet';
  if (t.includes('electric')) return 'zap';
  if (t.includes('handyman')) return 'wrench';
  if (t.includes('refriger') || t.includes('hvac')) return 'snow';
  if (t.includes('applianc')) return 'plug';
  if (t.includes('roof')) return 'home';
  return 'tag';
}
