import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LOGO } from '../lib/brand';
import { ThemeToggle } from '../theme/ThemeToggle';
import { Icon, IconSprite } from './Icon';
import { NavIcon } from './NavIcon';
import type { IconName } from './Icon';
import { ActorSwitcher } from './ActorSwitcher';
import { CanvasBackdrop } from './CanvasBackdrop';
import { SidebarScribble } from './SidebarScribble';
import { GlobalSearch } from './GlobalSearch';
import { OKnobScrollbar } from './OKnobScrollbar';
import { useAuth } from '../auth/AuthProvider';
import { useSidebarCollapsed } from '../hooks/useSidebarCollapsed';
import { ADMIN_SECTIONS } from '../lib/adminSections';
import { initialsOf, roleLabel } from '../lib/actor';

/** The two nav items that lead somewhere. Everything else still renders (the
    shape of the product is part of the design) but stays inert. */
export type NavKey = 'Dashboard' | 'Work Orders' | 'Quotes' | 'Admin';

interface NavChild {
  label: string;
  to: string;
}

interface NavItem {
  label: string;
  icon: IconName;
  /** Route this item navigates to; absent = inert, later-sprint item. */
  to?: string;
  /** Marks the item whose badge carries the live work-order count. */
  badge?: 'total';
  /** A section with enough destinations to deserve its own disclosure. The
      header stops navigating and becomes the toggle; the children are the
      routes (Signals in the reference nav works the same way). */
  children?: NavChild[];
}

/** Module-level so the open-group state can be seeded from the current URL
    before the component body runs. */
const NAV: NavItem[] = [
  { label: 'Dashboard', icon: 'grid', to: '/dashboard' },
  { label: 'Work Orders', icon: 'clipboard', to: '/', badge: 'total' },
  { label: 'Vendors', icon: 'truck' },
  { label: 'Quotes', icon: 'file', to: '/quotes' },
  { label: 'Invoicing', icon: 'dollar' },
  // S5 — Admin is six sections deep, so it renders as a group rather than a
  // single item that hides five destinations behind an in-page rail.
  {
    label: 'Admin',
    icon: 'sliders',
    children: ADMIN_SECTIONS.map((sec) => ({ label: sec.label, to: sec.to })),
  },
];

interface AppShellProps {
  children: ReactNode;
  total?: number;
  /** Breadcrumb node rendered at the far left of the black topbar. */
  breadcrumb?: ReactNode;
  /** Which nav item reads as current. Defaults to Work Orders. */
  active?: NavKey;
  /** Glyph for the canvas O-knob's thumb in place of the O — the WO detail
      page passes its trade's icon so the knob wears the job. */
  knobIcon?: IconName;
}

/** Black-topbar + themed-sidebar chrome (SPRINT1-SPEC §6). "Work Orders" stays
    the active item on every WO route (detail, quote, payment request). */
export function AppShell({
  children,
  total,
  breadcrumb,
  active = 'Work Orders',
  knobIcon,
}: AppShellProps) {
  const navigate = useNavigate();
  // Collapsing the sidebar to an icon rail gives the canvas ~170px back — it
  // persists across routes and reloads, and answers to Cmd/Ctrl+B.
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  const { pathname } = useLocation();
  // The canvas scroller, handed to the O-knob overlay that replaces its bar.
  const canvasRef = useRef<HTMLElement>(null);
  // A group opens itself when the route you are on lives inside it, so a deep
  // link never lands you next to a nav that looks unrelated to the page.
  const [openGroups, setOpenGroups] = useState<string[]>(() =>
    NAV.filter((i) => i.children?.some((c) => c.to === pathname)).map((i) => i.label),
  );

  const toggleGroup = (label: string) => {
    // Collapsed there is nowhere to draw the children — open the rail first.
    if (collapsed) {
      toggleCollapsed();
      setOpenGroups((g) => (g.includes(label) ? g : [...g, label]));
      return;
    }
    setOpenGroups((g) => (g.includes(label) ? g.filter((l) => l !== label) : [...g, label]));
  };
  // S5 — identity comes from the session, not from a client-side pin. `actingAs`
  // is who the app behaves as; `user` is the human who actually signed in, and
  // super-admin rights are always read from the latter.
  const { user, actingAs, isImpersonating, signOut } = useAuth();

  // ── Hover flyout ──────────────────────────────────────────────────────────
  // Hovering a nav item shows what is inside it without committing to opening
  // it: Admin's six sections are pickable straight from the flyout, and on the
  // collapsed rail every item gets its name back. Positioned FIXED off the
  // item's own rect, because .side-nav scrolls and would clip an absolute one.
  const [flyout, setFlyout] = useState<{ label: string; top: number; left: number } | null>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const openFlyout = (item: NavItem, el: HTMLElement) => {
    cancelClose();
    const r = el.getBoundingClientRect();
    // Rows + header, clamped so a flyout near the foot of the rail stays on
    // screen rather than running under the viewport edge.
    const height = 14 + 26 + (item.children?.length ?? 0) * 30;
    setFlyout({
      label: item.label,
      top: Math.max(8, Math.min(r.top - 6, window.innerHeight - height - 8)),
      left: r.right + 8,
    });
  };

  const scheduleClose = () => {
    cancelClose();
    // Enough grace to cross the 8px gap diagonally without losing the panel.
    closeTimer.current = window.setTimeout(() => setFlyout(null), 180);
  };

  useEffect(() => cancelClose, []);

  // A scroll or a resize invalidates the measured rect, and Escape is the way
  // out of any transient overlay.
  useEffect(() => {
    if (!flyout) return;
    const dismiss = () => setFlyout(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [flyout]);

  const goFromFlyout = (to: string) => {
    setFlyout(null);
    navigate(to);
  };

  const flyoutItem = flyout ? NAV.find((i) => i.label === flyout.label) : undefined;

  return (
    <div className={`shell${collapsed ? ' is-collapsed' : ''}`}>
      <IconSprite />
      {/* The bar spans the full width and the sidebar hangs below it, so the
          logo sits in the bar rather than above the nav. Three columns —
          brand+trail, search, actions — with the outer two on equal fractions,
          so the search sits on the bar's own centre line rather than wherever
          the trail happens to end. */}
      <header className="topbar">
        <div className="topbar-left">
          {/* --brand-url lets app.css draw the collapsed "the"/"One" pieces
              from the same asset without repeating its path. */}
          <div className="topbar-brand" style={{ '--brand-url': `url(${LOGO})` } as CSSProperties}>
            <img src={LOGO} alt="The One" />
          </div>
          {/* Detail routes pass their own trail; list routes get the nav item
              they are on, plus its section when the item has children. */}
          {breadcrumb ?? <NavCrumbs active={active} pathname={pathname} />}
        </div>
        <GlobalSearch />
        <div className="topbar-actions">
          <ActorSwitcher />
          <button type="button" className="topbar-bell" aria-label="Notifications">
            <Icon name="bell" />
          </button>
          <ThemeToggle />
        </div>
      </header>

      <div className="shell-body">
        <aside className="sidebar">
          <div className="side-head">
            <button
              type="button"
              className="side-collapse"
              onClick={toggleCollapsed}
              aria-expanded={!collapsed}
              aria-controls="primary-nav"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (Ctrl+B)`}
            >
              <Icon name={collapsed ? 'chevs-r' : 'chevs-l'} size={16} />
            </button>
          </div>
          <nav className="side-nav" id="primary-nav" aria-label="Primary">
            {NAV.map((item) => {
              const isActive = item.label === active;
              const count = item.badge === 'total' ? total : undefined;

              // ── Group: header discloses the children, it does not navigate ──
              if (item.children) {
                const open = !collapsed && openGroups.includes(item.label);
                const panelId = `side-group-${item.label.toLowerCase().replace(/\s+/g, '-')}`;
                return (
                  <div
                    key={item.label}
                    className={`side-group${open ? ' is-open' : ''}${isActive ? ' is-current' : ''}`}
                    // Rail only. With the sidebar open the header's own caret
                    // is the way in, and a panel over the canvas on every pass
                    // of the pointer is noise, not help.
                    onMouseEnter={(e) => collapsed && openFlyout(item, e.currentTarget)}
                    onMouseLeave={scheduleClose}
                  >
                    <button
                      type="button"
                      className={`side-item side-item-group${isActive ? ' is-active' : ''}`}
                      aria-expanded={open}
                      aria-controls={panelId}
                      onFocus={(e) => collapsed && openFlyout(item, e.currentTarget)}
                      onClick={() => toggleGroup(item.label)}
                    >
                      <span className="side-icon">
                        <NavIcon name={item.icon} />
                      </span>
                      <span className="side-label">{item.label}</span>
                      <span className="side-caret" aria-hidden="true">
                        <Icon name={open ? 'chev-u' : 'chev-d'} size={14} />
                      </span>
                    </button>
                    {open && (
                      <div className="side-sub" id={panelId}>
                        {item.children.map((child) => {
                          const childActive = pathname === child.to;
                          return (
                            <button
                              type="button"
                              key={child.to}
                              className={`side-subitem${childActive ? ' is-active' : ''}`}
                              aria-current={childActive ? 'page' : undefined}
                              onClick={() => navigate(child.to)}
                            >
                              {child.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }

              // ── Leaf ────────────────────────────────────────────────────────
              // A leaf has nothing to preview while the sidebar is open — the
              // row already carries its name, and a panel that repeats it is
              // noise on the pointer. Only the collapsed rail, where the label
              // is hidden, gets one.
              const previewable = collapsed;
              // The wrapper, not the button, carries the hover: a disabled
              // button swallows pointer events, so the inert items would
              // otherwise never fire one on the rail either.
              return (
                <div
                  key={item.label}
                  className="side-leaf"
                  onMouseEnter={(e) => previewable && openFlyout(item, e.currentTarget)}
                  onMouseLeave={scheduleClose}
                >
                  <button
                    type="button"
                    className={`side-item${isActive ? ' is-active' : ''}`}
                    aria-current={isActive ? 'page' : undefined}
                    disabled={!item.to}
                    onFocus={(e) => previewable && openFlyout(item, e.currentTarget)}
                    onClick={item.to ? () => navigate(item.to as string) : undefined}
                  >
                    <span className="side-icon">
                      <NavIcon name={item.icon} />
                    </span>
                    <span className="side-label">{item.label}</span>
                    {count != null && (
                      <span className="side-badge">{count.toLocaleString('en-US')}</span>
                    )}
                  </button>
                </div>
              );
            })}
          </nav>

          {/* The tangle at the rail's empty foot — absolute, so the nav keeps
              its scroll room and the user card its row. */}
          <SidebarScribble />

          {/* One panel, moved and refilled — the hovered item's sections when it
              has them, its name (and why it is inert) when it does not. */}
          {flyout && flyoutItem && (
            <div
              className={`side-flyout${flyoutItem.children ? '' : ' is-tag'}`}
              style={{ top: flyout.top, left: flyout.left }}
              role={flyoutItem.children ? 'menu' : undefined}
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
            >
              <p className={`side-flyout-head${flyoutItem.children ? '' : ' is-solo'}`}>
                {flyoutItem.label}
              </p>
              {flyoutItem.children ? (
                flyoutItem.children.map((child) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={child.to}
                    className={`side-flyout-item${pathname === child.to ? ' is-active' : ''}`}
                    aria-current={pathname === child.to ? 'page' : undefined}
                    onClick={() => goFromFlyout(child.to)}
                  >
                    {child.label}
                  </button>
                ))
              ) : null}
            </div>
          )}

          {/* The ACTING principal, not a hardcoded identity — this is who the API
              attributes every write to and whose role decides the gates. */}
          <div className="side-user">
            <span className="side-avatar" aria-hidden="true">
              {initialsOf(actingAs?.name)}
            </span>
            <span className="side-user-meta">
              <span className="side-user-name">{actingAs?.name ?? '—'}</span>
              <span className="side-user-role">
                {roleLabel(actingAs?.role)}
                {isImpersonating && <em className="side-user-imp"> · viewing as</em>}
              </span>
            </span>
            <button
              type="button"
              className="side-signout"
              aria-label={`Sign out ${user?.name ?? ''}`}
              title="Sign out"
              onClick={() => void signOut()}
            >
              <Icon name="ext" size={14} />
            </button>
          </div>
        </aside>

        {/* The wrap is the grid cell so the O-knob rail (the 1c scrollbar —
            the logo's ring riding a node line) can pin to the cell's edge
            while the canvas underneath scrolls with its native bar hidden. */}
        <div className="canvas-wrap">
          {/* Behind the canvas, not inside it: the waves stay put while the
              page scrolls over them, the way the sign-in route sits behind the
              card. Same backdrop on every tab — it belongs to the shell. */}
          <CanvasBackdrop />
          {/* data-oknob-own: the canvas rail is this sibling component, so the
              app-wide manager (lib/oknob.ts) must not mount a second one. */}
          <main className="canvas" ref={canvasRef} data-oknob-own="">{children}</main>
          <OKnobScrollbar scrollRef={canvasRef} icon={knobIcon} />
        </div>
      </div>
    </div>
  );
}

/** The default trail for list routes: the nav item you are on, plus the section
    inside it when that item has children (Admin → Users). Detail routes pass a
    richer `breadcrumb` of their own and never reach this. */
function NavCrumbs({ active, pathname }: { active: NavKey; pathname: string }) {
  const item = NAV.find((i) => i.label === active);
  const section = item?.children?.find((c) => c.to === pathname)?.label;

  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {section ? (
        <>
          <span className="crumb">{active}</span>
          <span className="crumb-sep" aria-hidden="true">/</span>
          <span className="crumb-cur is-nav" aria-current="page">{section}</span>
        </>
      ) : (
        <span className="crumb-cur is-nav" aria-current="page">{active}</span>
      )}
    </nav>
  );
}
