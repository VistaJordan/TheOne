import type { IconName } from '../components/Icon';

export interface AdminSection {
  to: string;
  label: string;
  icon: IconName;
}

/** Order is the nav's order. Users first — it is what the console is for.
    Lives here rather than in AdminShell so the sidebar can list the sections
    without importing the page that AppShell itself renders. */
export const ADMIN_SECTIONS: AdminSection[] = [
  { to: '/admin/users', label: 'Users', icon: 'user' },
  { to: '/admin/roles', label: 'Roles', icon: 'layers' },
  { to: '/admin/settings', label: 'Settings', icon: 'sliders' },
  { to: '/admin/automations', label: 'Automations', icon: 'zap' },
  { to: '/admin/fields', label: 'Custom fields', icon: 'list' },
  { to: '/admin/themes', label: 'Themes', icon: 'sun' },
  { to: '/admin/audit', label: 'Audit log', icon: 'history' },
  { to: '/admin/trash', label: 'Trash', icon: 'trash' },
];
