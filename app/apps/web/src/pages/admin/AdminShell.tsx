/* Admin Studio — the panel the route selects.

   The section list (Users · Roles · Settings · Automations · Custom fields ·
   Themes · Audit log · Trash) lives in the primary sidebar as an expandable
   "Admin" group, so this screen does not repeat it in a second in-page rail —
   one nav for one set of destinations.

   Access (0015): each section is its own permission (`admin/<section>` view),
   read from the REAL signed-in user, never from who they are viewing as. Super
   admins hold every one. */

import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { adminPermKey } from '@theone/shared';
import { AppShell } from '../../components/AppShell';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import { useAuth } from '../../auth/AuthProvider';

// The canonical list moved to lib/adminSections so the sidebar can read it
// without importing this module (which imports AppShell).
export { ADMIN_SECTIONS } from '../../lib/adminSections';
export type { AdminSection } from '../../lib/adminSections';

interface AdminShellProps {
  title: string;
  subtitle?: ReactNode;
  /** Rendered at the right of the title row — tabs, buttons. */
  actions?: ReactNode;
  children: ReactNode;
}

/** '/admin/fields' → 'fields' — the permission path segment. */
export function adminSectionOf(pathname: string): string {
  const m = /^\/admin\/([a-z-]+)/.exec(pathname);
  return m ? m[1] : 'users';
}

export function AdminShell({ title, subtitle, actions, children }: AdminShellProps) {
  const { user, adminCan } = useAuth();
  const { pathname } = useLocation();
  const section = adminSectionOf(pathname);

  // Locked-with-a-reason rather than a 404: a dispatcher who lands here from a
  // shared link should learn what this is and who to ask, not meet a dead end
  // (quotes-payments.md §3.5).
  if (!user || !adminCan(adminPermKey(section), 'view')) {
    return (
      <AppShell active="Admin">
        <div className="wo-state">
          <Icon name="lock" size={22} />
          <b>This part of the admin console is not available to you</b>
          <span>Ask a super admin — Elise, Jordan, Jeff or Jack — if you need access.</span>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell active="Admin">
      <div className="adm-layout">
        <section className="adm-content">
          <header className="adm-head">
            <div className="adm-head-text">
              {/* The topbar trail already names the section (Admin / Settings),
                  so printing it again at the top of the canvas says the same
                  thing twice. It stays in the a11y tree as the page's heading,
                  it just does not take a second line of the screen. */}
              <h2 className="adm-title u-sr-only">{title}</h2>
              {subtitle && <p className="adm-sub">{subtitle}</p>}
            </div>
            {actions && <div className="adm-head-actions">{actions}</div>}
          </header>
          {children}
        </section>
      </div>
    </AppShell>
  );
}

/** Shared empty/placeholder body so every section reads the same when bare. */
export function AdminEmpty({
  icon,
  title,
  children,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="adm-empty">
      <Icon name={icon} size={22} />
      <b>{title}</b>
      {children && <span>{children}</span>}
    </div>
  );
}
