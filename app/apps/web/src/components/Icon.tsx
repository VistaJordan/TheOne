/* Lucide-style icon set, ported verbatim from the approved WO-detail comp.
   The comp inlines one <svg><defs> sprite and references symbols with <use>.
   We do the same: <IconSprite/> renders once inside AppShell, <Icon name=…/>
   emits the 10-byte <use> reference. Stroke/size come from the .ic classes. */

export type IconName =
  | 'grid' | 'clipboard' | 'truck' | 'file' | 'dollar' | 'sliders'
  | 'search' | 'bell' | 'sun' | 'moon' | 'chev-r' | 'arrow-l' | 'arrow-r'
  | 'copy' | 'check' | 'check-circle' | 'circle' | 'alert' | 'package'
  | 'phone' | 'pin' | 'lock' | 'globe' | 'send' | 'clip' | 'image'
  | 'camera' | 'dots' | 'swap' | 'snow' | 'flag' | 'list' | 'inbox'
  | 'store' | 'ext' | 'plus'
  // S3 — Messages tab (ported verbatim from the approved messages comp)
  | 'msg' | 'phone-in' | 'phone-out' | 'radio' | 'briefcase' | 'zap'
  | 'chev-d' | 'check-check' | 'clock' | 'info'
  // S4 — Quote builder + payment request (ported verbatim from those comps)
  | 'user' | 'user-plus' | 'grip' | 'trash' | 'pencil' | 'refresh' | 'x'
  | 'tag' | 'upload' | 'card' | 'alert-circle' | 'sort' | 'sort-down' | 'history'
  // S5 — sidebar chrome: collapse control + group disclosure
  | 'chevs-l' | 'chevs-r' | 'chev-u'
  // S6 — the work-order list toolbar: filters, columns, grouping, import/export
  | 'filter' | 'columns' | 'layers' | 'download'
  // S7 — sign-in route stops (work orders · quotes · operations)
  | 'wrench' | 'user-cog';

type IconSize = 12 | 14 | 16 | 18 | 22;

interface IconProps {
  name: IconName;
  size?: IconSize;
  className?: string;
}

/** A single sprite reference. `size` maps to the comp's .ic-NN modifiers. */
export function Icon({ name, size = 16, className }: IconProps) {
  const cls = ['ic', size === 16 ? '' : `ic-${size}`, className].filter(Boolean).join(' ');
  return (
    <svg className={cls} aria-hidden="true" focusable="false">
      <use href={`#i-${name}`} />
    </svg>
  );
}

/** The sprite itself — render exactly once per document. */
export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        <symbol id="i-wrench" viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></symbol>
        <symbol id="i-user-cog" viewBox="0 0 24 24"><circle cx="18" cy="15" r="3" /><circle cx="9" cy="7" r="4" /><path d="M10 15H6a4 4 0 0 0-4 4v2" /><path d="m21.7 16.4-.9-.3M15.2 13.9l-.9-.3M16.6 18.7l.3-.9M19.1 12.2l.3-.9M19.6 18.7l-.4-1M16.8 12.3l-.4-1M14.3 16.6l1-.4M20.7 13.8l1-.4" /></symbol>
        <symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></symbol>
        <symbol id="i-clipboard" viewBox="0 0 24 24"><path d="M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1Z" /><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" /><path d="M8 11h8M8 15h5" /></symbol>
        <symbol id="i-truck" viewBox="0 0 24 24"><path d="M3 6h11v9H3z" /><path d="M14 9h4l3 3v3h-7z" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></symbol>
        <symbol id="i-file" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></symbol>
        <symbol id="i-dollar" viewBox="0 0 24 24"><line x1="12" y1="2" x2="12" y2="22" /><path d="M17 5.5H9.8a3.3 3.3 0 0 0 0 6.6h4.4a3.3 3.3 0 0 1 0 6.6H6" /></symbol>
        <symbol id="i-sliders" viewBox="0 0 24 24"><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1.5" y1="14" x2="6.5" y2="14" /><line x1="9.5" y1="8" x2="14.5" y2="8" /><line x1="17.5" y1="16" x2="22.5" y2="16" /></symbol>
        <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" /></symbol>
        <symbol id="i-bell" viewBox="0 0 24 24"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></symbol>
        <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></symbol>
        <symbol id="i-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></symbol>
        <symbol id="i-chev-r" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6" /></symbol>
        <symbol id="i-arrow-l" viewBox="0 0 24 24"><line x1="20" y1="12" x2="5" y2="12" /><polyline points="11 5 5 12 11 19" /></symbol>
        <symbol id="i-arrow-r" viewBox="0 0 24 24"><line x1="4" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" /></symbol>
        <symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></symbol>
        <symbol id="i-check" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></symbol>
        <symbol id="i-check-circle" viewBox="0 0 24 24"><path d="M21.5 11.1V12a9.5 9.5 0 1 1-5.6-8.7" /><polyline points="21.5 4.6 12 14.1 9.2 11.3" /></symbol>
        <symbol id="i-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /></symbol>
        <symbol id="i-alert" viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><line x1="12" y1="9" x2="12" y2="13.5" /><line x1="12" y1="17.2" x2="12.01" y2="17.2" /></symbol>
        <symbol id="i-package" viewBox="0 0 24 24"><path d="m7.5 4.3 9 5.2" /><path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><polyline points="3.3 7 12 12 20.7 7" /><line x1="12" y1="22" x2="12" y2="12" /></symbol>
        <symbol id="i-phone" viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z" /></symbol>
        <symbol id="i-pin" viewBox="0 0 24 24"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></symbol>
        <symbol id="i-lock" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></symbol>
        <symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><line x1="3" y1="12" x2="21" y2="12" /><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" /></symbol>
        <symbol id="i-send" viewBox="0 0 24 24"><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4Z" /></symbol>
        <symbol id="i-clip" viewBox="0 0 24 24"><path d="M21.4 11.05 12.25 20.2a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></symbol>
        <symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.6" cy="8.6" r="1.6" /><path d="m21 15-5-5L5 21" /></symbol>
        <symbol id="i-camera" viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5L8.5 3h7l2 3H21a2 2 0 0 1 2 2Z" /><circle cx="12" cy="13" r="4" /></symbol>
        <symbol id="i-dots" viewBox="0 0 24 24"><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" /></symbol>
        <symbol id="i-swap" viewBox="0 0 24 24"><polyline points="16 2.5 20.5 7 16 11.5" /><path d="M20.5 7H3.5" /><polyline points="8 12.5 3.5 17 8 21.5" /><path d="M3.5 17h17" /></symbol>
        <symbol id="i-snow" viewBox="0 0 24 24"><line x1="12" y1="2.5" x2="12" y2="21.5" /><line x1="3.8" y1="7.2" x2="20.2" y2="16.8" /><line x1="3.8" y1="16.8" x2="20.2" y2="7.2" /><polyline points="9.6 4.9 12 7.3 14.4 4.9" /><polyline points="9.6 19.1 12 16.7 14.4 19.1" /></symbol>
        <symbol id="i-flag" viewBox="0 0 24 24"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1Z" /><line x1="4" y1="22" x2="4" y2="15" /></symbol>
        <symbol id="i-list" viewBox="0 0 24 24"><line x1="9" y1="6" x2="21" y2="6" /><line x1="9" y1="12" x2="21" y2="12" /><line x1="9" y1="18" x2="21" y2="18" /><circle cx="4.3" cy="6" r="1.2" fill="currentColor" stroke="none" /><circle cx="4.3" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="4.3" cy="18" r="1.2" fill="currentColor" stroke="none" /></symbol>
        <symbol id="i-inbox" viewBox="0 0 24 24"><polyline points="21 12 16 12 14.5 15 9.5 15 8 12 3 12" /><path d="M5.5 5.1 3.3 11.3A2 2 0 0 0 3 12v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-.3-.7L18.5 5.1A2 2 0 0 0 16.6 4H7.4a2 2 0 0 0-1.9 1.1Z" /></symbol>
        <symbol id="i-store" viewBox="0 0 24 24"><path d="M3 21h18" /><path d="M4.5 21V9.5" /><path d="M19.5 21V9.5" /><path d="M3.2 9.5 5 3.5h14l1.8 6a3 3 0 0 1-5.9.7 3 3 0 0 1-5.9 0 3 3 0 0 1-5.8-.7Z" /><rect x="9.8" y="14" width="4.4" height="7" /></symbol>
        <symbol id="i-ext" viewBox="0 0 24 24"><path d="M18 13.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5.5" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></symbol>
        <symbol id="i-plus" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></symbol>
        {/* ── S3 · Messages ─────────────────────────────────────────────── */}
        <symbol id="i-msg" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z" /></symbol>
        <symbol id="i-phone-in" viewBox="0 0 24 24"><polyline points="16 2 16 8 22 8" /><line x1="23" y1="1" x2="16" y2="8" /><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z" /></symbol>
        <symbol id="i-phone-out" viewBox="0 0 24 24"><polyline points="23 7 23 1 17 1" /><line x1="16" y1="8" x2="23" y2="1" /><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z" /></symbol>
        <symbol id="i-radio" viewBox="0 0 24 24"><path d="M4.9 19.1a10 10 0 0 1 0-14.2" /><path d="M7.8 16.2a6 6 0 0 1 0-8.4" /><circle cx="12" cy="12" r="2" /><path d="M16.2 7.8a6 6 0 0 1 0 8.4" /><path d="M19.1 4.9a10 10 0 0 1 0 14.2" /></symbol>
        <symbol id="i-briefcase" viewBox="0 0 24 24"><rect x="2.5" y="7" width="19" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></symbol>
        <symbol id="i-zap" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></symbol>
        <symbol id="i-chev-d" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9" /></symbol>
        <symbol id="i-check-check" viewBox="0 0 24 24"><path d="M17 6 6.5 17 2 12.5" /><path d="M22 8.5 13.5 17l-1.7-1.7" /></symbol>
        <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><polyline points="12 6.8 12 12 15.6 14" /></symbol>
        <symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16.4" /><line x1="12" y1="7.8" x2="12.01" y2="7.8" /></symbol>
        {/* ── S4 · Quote builder + payment request ──────────────────────── */}
        <symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.6" /><path d="M4.6 20a7.4 7.4 0 0 1 14.8 0" /></symbol>
        <symbol id="i-user-plus" viewBox="0 0 24 24"><circle cx="9.5" cy="8" r="3.6" /><path d="M2.6 20a7 7 0 0 1 13.8 0" /><line x1="19" y1="7" x2="19" y2="13" /><line x1="16" y1="10" x2="22" y2="10" /></symbol>
        <symbol id="i-grip" viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none" /><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none" /><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none" /><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none" /></symbol>
        <symbol id="i-trash" viewBox="0 0 24 24"><polyline points="3.5 6 20.5 6" /><path d="M8.5 6V4.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5V6" /><path d="M18.5 6v13a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></symbol>
        <symbol id="i-pencil" viewBox="0 0 24 24"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5Z" /></symbol>
        <symbol id="i-refresh" viewBox="0 0 24 24"><polyline points="21 4 21 10 15 10" /><polyline points="3 20 3 14 9 14" /><path d="M20 10a8 8 0 0 0-14.1-3.4L3 10" /><path d="M4 14a8 8 0 0 0 14.1 3.4L21 14" /></symbol>
        <symbol id="i-chevs-l" viewBox="0 0 24 24"><polyline points="11 18 5 12 11 6" /><polyline points="18 18 12 12 18 6" /></symbol>
        <symbol id="i-chevs-r" viewBox="0 0 24 24"><polyline points="13 18 19 12 13 6" /><polyline points="6 18 12 12 6 6" /></symbol>
        <symbol id="i-chev-u" viewBox="0 0 24 24"><polyline points="6 15 12 9 18 15" /></symbol>
        <symbol id="i-filter" viewBox="0 0 24 24"><polygon points="3 4 21 4 14 12.5 14 20 10 18 10 12.5" /></symbol>
        <symbol id="i-columns" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="9" y1="4" x2="9" y2="20" /><line x1="15" y1="4" x2="15" y2="20" /></symbol>
        <symbol id="i-layers" viewBox="0 0 24 24"><polygon points="12 3 21 8 12 13 3 8" /><polyline points="3 13 12 18 21 13" /><polyline points="3 17.5 12 22 21 17.5" /></symbol>
        <symbol id="i-download" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></symbol>
        <symbol id="i-x" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></symbol>
        <symbol id="i-tag" viewBox="0 0 24 24"><path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z" /><circle cx="7.5" cy="7.5" r="1.4" /></symbol>
        <symbol id="i-upload" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7.5 8.5 12 4 16.5 8.5" /><line x1="12" y1="4" x2="12" y2="15.5" /></symbol>
        <symbol id="i-card" viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="2" /><line x1="2.5" y1="10" x2="21.5" y2="10" /><line x1="6.5" y1="15" x2="10" y2="15" /></symbol>
        <symbol id="i-alert-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><line x1="12" y1="7.5" x2="12" y2="12.8" /><line x1="12" y1="16.4" x2="12.01" y2="16.4" /></symbol>
        <symbol id="i-sort" viewBox="0 0 24 24"><polyline points="8 9.5 12 5.5 16 9.5" /><polyline points="8 14.5 12 18.5 16 14.5" /></symbol>
        <symbol id="i-sort-down" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19" /><polyline points="7 14 12 19 17 14" /></symbol>
        <symbol id="i-history" viewBox="0 0 24 24"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" /><polyline points="3 4 3 9 8 9" /><polyline points="12 7.5 12 12 15.2 13.8" /></symbol>
      </defs>
    </svg>
  );
}
