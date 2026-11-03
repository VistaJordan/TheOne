/** The OBI hologram (the rebrand from "The One"): the top bar, the sign-in
    card and the client / vendor share pages. Transparent, so it sits on
    whatever is behind it. Day draws the light
    art; night swaps in the dark one rather than inverting, since both were
    drawn. Framed by components/ObiLogo.tsx. */
export const OBI_LOGO_DAY = '/brand/OBI-hologram-light-transparent.svg';
export const OBI_LOGO_NIGHT = '/brand/OBI-hologram-dark-transparent.svg';

/** The OBI badge in the top bar, above the sidebar (Elise, 2026-11-03): one
    art at 190×41 with 2× and 3× copies for sharp screens. It carries its own
    light tile, so it is the same in both themes. */
export const OBI_HEADER_LOGO = '/brand/obi-logo-header.png';
export const OBI_HEADER_LOGO_SRCSET =
  '/brand/obi-logo-header.png 1x, /brand/obi-logo-header@2x.png 2x, /brand/obi-logo-header@3x.png 3x';
/** The badge is too wide for the collapsed 64px rail; a square OBI mark in
    the badge's own colours stands in for it there. */
export const OBI_HEADER_MARK = '/brand/obi-logo-header-mark.svg';
