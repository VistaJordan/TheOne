import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../theme/ThemeProvider';
import { ThemeToggle } from '../theme/ThemeToggle';
import { Icon, IconSprite } from './Icon';
import type { IconName } from './Icon';
import { ActorSwitcher, useActor } from './ActorSwitcher';
import { initialsOf, roleLabel } from '../lib/actor';

/** The two nav items that lead somewhere. Everything else still renders (the
    shape of the product is part of the design) but stays inert. */
export type NavKey = 'Work Orders' | 'Quotes';

interface NavItem {
  label: string;
  icon: IconName;
  /** Route this item navigates to; absent = inert, later-sprint item. */
  to?: string;
  badge?: number;
}

interface AppShellProps {
  children: ReactNode;
  total?: number;
  /** Omit search entirely (detail routes) by leaving these undefined. */
  search?: string;
  onSearchChange?: (v: string) => void;
  /** Breadcrumb node rendered at the far left of the black topbar. */
  breadcrumb?: ReactNode;
  /** Which nav item reads as current. Defaults to Work Orders. */
  active?: NavKey;
}

/** Black-topbar + themed-sidebar chrome (SPRINT1-SPEC §6). "Work Orders" stays
    the active item on every WO route (detail, quote, payment request). */
export function AppShell({
  children,
  total,
  search,
  onSearchChange,
  breadcrumb,
  active = 'Work Orders',
}: AppShellProps) {
  const { theme } = useTheme();
  const navigate = useNavigate();
  // One source of truth for "who am I acting as" — the topbar select sets it,
  // the sidebar chip below reflects it, the api client sends it.
  const actor = useActor();
  // Sidebar ground differs by theme → swap the logo to match its background.
  const logo = theme === 'night' ? '/brand/logo-black.png' : '/brand/logo-white.png';

  const nav: NavItem[] = [
    { label: 'Dashboard', icon: 'grid' },
    { label: 'Work Orders', icon: 'clipboard', to: '/', badge: total },
    { label: 'Vendors', icon: 'truck' },
    { label: 'Quotes', icon: 'file', to: '/quotes' },
    { label: 'Invoicing', icon: 'dollar' },
    { label: 'Admin', icon: 'sliders' },
  ];

  return (
    <div className="shell">
      <IconSprite />
      <aside className="sidebar">
        <div className="side-logo">
          <img src={logo} alt="Seamless FM" />
        </div>
        <nav className="side-nav" aria-label="Primary">
          {nav.map((item) => (
            <button
              type="button"
              key={item.label}
              className={`side-item${item.label === active ? ' is-active' : ''}`}
              aria-current={item.label === active ? 'page' : undefined}
              disabled={!item.to}
              title={item.to ? undefined : 'Coming in a later sprint'}
              onClick={item.to ? () => navigate(item.to as string) : undefined}
            >
              <span className="side-icon">
                <Icon name={item.icon} size={18} />
              </span>
              <span className="side-label">{item.label}</span>
              {item.badge != null && (
                <span className="side-badge">{item.badge.toLocaleString('en-US')}</span>
              )}
            </button>
          ))}
        </nav>
        {/* The ACTING principal, not a hardcoded identity — this is who the API
            attributes every write to and whose role decides the gates. */}
        <div className="side-user">
          <span className="side-avatar" aria-hidden="true">
            {initialsOf(actor.acting?.name)}
          </span>
          <span className="side-user-meta">
            <span className="side-user-name">{actor.acting?.name ?? '—'}</span>
            <span className="side-user-role">{roleLabel(actor.acting?.role)}</span>
          </span>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          {breadcrumb}
          {onSearchChange && (
            <div className="topbar-search">
              <span className="topbar-search-icon" aria-hidden="true">
                <Icon name="search" size={14} />
              </span>
              <input
                type="search"
                placeholder="Search work orders…"
                value={search ?? ''}
                onChange={(e) => onSearchChange(e.target.value)}
                aria-label="Search work orders"
              />
            </div>
          )}
          <div className="topbar-actions">
            <button type="button" className="btn-newwo" disabled title="Coming in a later sprint">
              <Icon name="plus" size={14} />
              New Work Order
            </button>
            <ActorSwitcher actor={actor} />
            <button type="button" className="topbar-bell" aria-label="Notifications">
              <Icon name="bell" />
            </button>
            <ThemeToggle />
          </div>
        </header>
        <main className="canvas">{children}</main>
      </div>
    </div>
  );
}
