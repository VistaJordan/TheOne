/* Admin › Users and Admin › Roles — two sections, one module.
     Users  · who exists, what role they hold, whether they can sign in — and,
              for super admins, an "Adjust" per person that layers exceptions
              on top of their role (0015)
     Roles  · what roles exist and exactly what each may see and do, as one
              tree: sections, tabs, field sections, fields

   They used to share one page behind a Users/Roles toggle. Each is now its own
   route so the Admin rail lists them side by side (Users first) and each one
   is seen alone. */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { buildPermissionTree, type PermMap, type PermNode } from '@theone/shared';
import { AdminShell } from './AdminShell';
import { Icon } from '../../components/Icon';
import { PermissionMatrix } from '../../components/admin/PermissionMatrix';
import { useAuth } from '../../auth/AuthProvider';
import {
  createRole,
  deleteRole,
  getUserPermissions,
  inviteUser,
  listAdminUsers,
  listPermissionFields,
  listRoles,
  setUserPermissions,
  updateRole,
  updateUser,
  type AdminUserItem,
  type RoleRecord,
  type UserStatus,
} from '../../api/client';
import { initialsOf } from '../../lib/actor';

const STATUS_COPY: Record<UserStatus, { label: string; tone: string; hint: string }> = {
  active: { label: 'Active', tone: 'ok', hint: 'Has signed in at least once' },
  invited: { label: 'Invited', tone: 'warn', hint: 'Can sign in, but never has' },
  disabled: { label: 'Disabled', tone: 'off', hint: 'Blocked from signing in' },
};

/** One error strip + cache invalidation, shared by both sections. */
function useAdminFeedback() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const fail = (e: Error) => setError(e.message || 'Something went wrong.');
  const done = (keys: string[]) => {
    setError(null);
    keys.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
  };
  const strip = error ? (
    <div className="callout callout-lock" role="alert" style={{ marginBottom: 16 }}>
      <Icon name="alert" size={14} />
      <span>{error}</span>
    </div>
  ) : null;
  return { fail, done, strip };
}

/** The whole permission tree, built from the unfiltered field catalogue. */
function usePermissionTree(enabled: boolean): PermNode[] {
  const q = useQuery({
    queryKey: ['permission-fields'],
    queryFn: listPermissionFields,
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });
  return useMemo(() => buildPermissionTree(q.data?.items ?? []), [q.data]);
}

const same = (a: PermMap, b: PermMap) => JSON.stringify(a) === JSON.stringify(b);

// ── Admin › Users ────────────────────────────────────────────────────────────

export function AdminUsersPage() {
  const { user, adminCan } = useAuth();
  const { fail, done, strip } = useAdminFeedback();
  const [inviteOpen, setInviteOpen] = useState(false);
  // The user whose adjustments are open, if any (super admins only).
  const [adjusting, setAdjusting] = useState<string | null>(null);

  const allowed = adminCan('admin/users', 'view');
  const canEdit = adminCan('admin/users', 'edit');
  const isSuperAdmin = Boolean(user?.is_super_admin);

  const usersQuery = useQuery({ queryKey: ['admin-users'], queryFn: listAdminUsers, enabled: allowed, retry: 0 });
  // Roles feed the role <select> on every row and in the invite form.
  const rolesQuery = useQuery({ queryKey: ['admin-roles'], queryFn: listRoles, enabled: allowed, retry: 0 });
  const tree = usePermissionTree(isSuperAdmin);

  const users = usersQuery.data?.items ?? [];
  const roles = rolesQuery.data?.items ?? [];

  const patchUser = useMutation({
    mutationFn: (v: { id: string; input: Parameters<typeof updateUser>[1] }) => updateUser(v.id, v.input),
    onSuccess: () => done(['admin-users', 'admin-roles']),
    onError: fail,
  });
  const invite = useMutation({
    mutationFn: inviteUser,
    onSuccess: () => { setInviteOpen(false); done(['admin-users', 'admin-roles']); },
    onError: fail,
  });

  const superAdmins = users.filter((u) => u.is_super_admin && u.status !== 'disabled').length;

  return (
    <AdminShell
      title="Users"
      subtitle={`${users.length} user${users.length === 1 ? '' : 's'} · ${superAdmins} super admin${superAdmins === 1 ? '' : 's'}`}
    >
      {strip}

      {canEdit && (
        <div className="toolbar">
          <button type="button" className="btn btn-primary" onClick={() => setInviteOpen((v) => !v)}>
            <Icon name="user-plus" size={14} />
            Invite a user
          </button>
        </div>
      )}

      {inviteOpen && (
        <InviteForm
          roles={roles}
          busy={invite.isPending}
          onCancel={() => setInviteOpen(false)}
          onSubmit={(v) => invite.mutate(v)}
        />
      )}

      <UsersTable
        items={users}
        roles={roles}
        selfId={user?.id}
        loading={usersQuery.isLoading}
        error={usersQuery.isError}
        busy={patchUser.isPending || !canEdit}
        canAdjust={isSuperAdmin}
        adjusting={adjusting}
        onAdjust={(id) => setAdjusting((cur) => (cur === id ? null : id))}
        tree={tree}
        onChange={(id, input) => patchUser.mutate({ id, input })}
      />
    </AdminShell>
  );
}

// ── Admin › Roles ────────────────────────────────────────────────────────────

export function AdminRolesPage() {
  const { adminCan } = useAuth();
  const { fail, done, strip } = useAdminFeedback();
  const [newRoleOpen, setNewRoleOpen] = useState(false);

  const allowed = adminCan('admin/roles', 'view');
  const canEdit = adminCan('admin/roles', 'edit');
  const rolesQuery = useQuery({ queryKey: ['admin-roles'], queryFn: listRoles, enabled: allowed, retry: 0 });
  const roles = rolesQuery.data?.items ?? [];
  const tree = usePermissionTree(allowed);

  const addRole = useMutation({
    mutationFn: createRole,
    onSuccess: () => { setNewRoleOpen(false); done(['admin-roles']); },
    onError: fail,
  });
  const patchRole = useMutation({
    mutationFn: (v: { id: string; input: Parameters<typeof updateRole>[1] }) => updateRole(v.id, v.input),
    onSuccess: () => done(['admin-roles', 'admin-users']),
    onError: fail,
  });
  const removeRole = useMutation({
    mutationFn: deleteRole,
    onSuccess: () => done(['admin-roles']),
    onError: fail,
  });

  return (
    <AdminShell
      title="Roles"
      subtitle={`${roles.length} role${roles.length === 1 ? '' : 's'} · open a role to set what it may see and do — a whole section at once, or field by field`}
    >
      {strip}

      {canEdit && (
        <div className="toolbar">
          <button type="button" className="btn btn-primary" onClick={() => setNewRoleOpen((v) => !v)}>
            <Icon name="plus" size={14} />
            New role
          </button>
        </div>
      )}

      {newRoleOpen && (
        <RoleForm
          roles={roles}
          tree={tree}
          busy={addRole.isPending}
          onCancel={() => setNewRoleOpen(false)}
          onSubmit={(v) => addRole.mutate(v)}
        />
      )}

      {rolesQuery.isLoading && <div className="adm-empty"><b>Loading roles…</b></div>}
      {rolesQuery.isError && <div className="adm-empty"><b>Could not load roles.</b></div>}

      <div className="role-list">
        {roles.map((r) => (
          <RoleCard
            key={r.id}
            role={r}
            tree={tree}
            busy={patchRole.isPending || removeRole.isPending}
            readOnly={!canEdit}
            onSave={(permissions) => patchRole.mutate({ id: r.id, input: { permissions } })}
            onDelete={() => removeRole.mutate(r.id)}
          />
        ))}
      </div>
    </AdminShell>
  );
}

// ── Users table ──────────────────────────────────────────────────────────────

function UsersTable({
  items, roles, selfId, loading, error, busy, canAdjust, adjusting, onAdjust, tree, onChange,
}: {
  items: AdminUserItem[];
  roles: RoleRecord[];
  selfId?: string;
  loading: boolean;
  error: boolean;
  busy: boolean;
  canAdjust: boolean;
  adjusting: string | null;
  onAdjust: (id: string) => void;
  tree: PermNode[];
  onChange: (id: string, input: { role?: string; is_super_admin?: boolean; status?: UserStatus }) => void;
}) {
  const cols = canAdjust ? 7 : 6;
  return (
    <div className="table-wrap">
      <table className="ct">
        <thead>
          <tr>
            <th>User</th><th>Role</th><th>Status</th><th>Super admin</th>
            <th>Last sign-in</th>
            {canAdjust && <th>Permissions</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {loading && <tr className="ct-empty"><td colSpan={cols}>Loading users…</td></tr>}
          {error && !loading && (
            <tr className="ct-empty"><td colSpan={cols}>Could not load users. Is the API running on :5174?</td></tr>
          )}
          {items.map((u) => {
            const isSelf = u.id === selfId;
            const status = STATUS_COPY[u.status];
            const off = u.status === 'disabled';
            const open = adjusting === u.id;
            return (
              <UserRows key={u.id} open={open}>
                <tr className={off ? 'is-dim' : undefined}>
                  <td>
                    <div className="site">
                      <strong>
                        <span className="side-avatar sm" aria-hidden="true">{initialsOf(u.name)}</span>
                        {u.name}
                        {isSelf && <span className="chip chip-sm">You</span>}
                      </strong>
                      <small>{u.email ?? '—'}</small>
                    </div>
                  </td>
                  <td>
                    <select className="fld sm" value={u.role ?? ''} disabled={busy || off}
                      aria-label={`Role for ${u.name}`} onChange={(e) => onChange(u.id, { role: e.target.value })}>
                      {roles.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                    </select>
                  </td>
                  <td><span className={`pill pill-${status.tone}`} title={status.hint}>{status.label}</span></td>
                  <td>
                    {/* Off for yourself: the server refuses it too, so a live
                        checkbox here would only produce an error. */}
                    <label className="sw sm" title={isSelf ? 'You cannot change your own super-admin access' : undefined}>
                      <input type="checkbox" checked={u.is_super_admin} disabled={busy || isSelf || off}
                        onChange={(e) => onChange(u.id, { is_super_admin: e.target.checked })} />
                      <span className="sw-track" aria-hidden="true" />
                      <span className="sr">Super admin</span>
                    </label>
                  </td>
                  <td>{u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : 'Never'}</td>
                  {canAdjust && (
                    <td>
                      {u.is_super_admin ? (
                        <span className="faint" title="A super admin already has every permission">Everything</span>
                      ) : (
                        <span className="confirm-row">
                          <button
                            type="button"
                            className="linkbtn"
                            disabled={off}
                            aria-expanded={open}
                            title="Allow or deny things for this person specifically, on top of their role"
                            onClick={() => onAdjust(u.id)}
                          >
                            <Icon name="user-cog" size={12} />
                            {open ? 'Close' : 'Adjust'}
                          </button>
                          {u.has_overrides && (
                            <span className="pill chip-adjusted" title="Has permissions set beyond the role">
                              Adjusted
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                  )}
                  <td className="num">
                    {off ? (
                      <button type="button" className="linkbtn" disabled={busy}
                        onClick={() => onChange(u.id, { status: 'invited' })}>Re-enable</button>
                    ) : (
                      <button type="button" className="linkbtn is-danger" disabled={busy || isSelf}
                        title={isSelf ? 'You cannot disable your own account' : 'Blocks sign-in and ends every live session'}
                        onClick={() => onChange(u.id, { status: 'disabled' })}>Disable</button>
                    )}
                  </td>
                </tr>
                {open && (
                  <tr className="user-adjust-row">
                    <td colSpan={cols}>
                      <UserAdjustPanel user={u} tree={tree} onClose={() => onAdjust(u.id)} />
                    </td>
                  </tr>
                )}
              </UserRows>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A row and its optional adjustment row, as one keyed unit. */
function UserRows({ children }: { open: boolean; children: React.ReactNode }) {
  return <>{children}</>;
}

/** The per-person override editor (0015). Everything unset comes from the
    role; a cell set here wins over the role wherever it is set. */
function UserAdjustPanel({
  user, tree, onClose,
}: {
  user: AdminUserItem;
  tree: PermNode[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['user-permissions', user.id],
    queryFn: () => getUserPermissions(user.id),
    retry: 0,
  });
  const [draft, setDraft] = useState<PermMap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (q.data) setDraft(q.data.overrides);
  }, [q.data]);

  const save = useMutation({
    mutationFn: (overrides: PermMap) => setUserPermissions(user.id, overrides),
    onSuccess: (res) => {
      setError(null);
      qc.setQueryData(['user-permissions', user.id], res);
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (e: Error) => setError(e.message || 'Could not save.'),
  });

  const saved = q.data?.overrides ?? {};
  const dirty = draft !== null && !same(draft, saved);

  return (
    <div className="user-adjust">
      <div className="user-adjust-head">
        <Icon name="user-cog" size={14} />
        <span>
          Adjusting <b>{user.name}</b> · role <b>{user.role_label ?? user.role ?? '—'}</b>. Faded cells
          are what the role gives; click one to set it for {user.name.split(' ')[0]} alone.
        </span>
      </div>
      {error && (
        <div className="callout callout-lock" role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </div>
      )}
      {q.isLoading || draft === null ? (
        <div className="adm-empty"><b>Loading permissions…</b></div>
      ) : q.isError ? (
        <div className="adm-empty"><b>Could not load this person’s permissions.</b></div>
      ) : (
        <PermissionMatrix
          tree={tree}
          value={draft}
          onChange={setDraft}
          base={q.data?.role_permissions ?? {}}
          baseLabel={`from the ${user.role_label ?? user.role ?? 'role'} role`}
          disabled={save.isPending}
        />
      )}
      <div className="role-save">
        <span className="faint">{dirty ? 'Unsaved adjustments' : 'Saved'}</span>
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <button type="button" className="btn" disabled={!dirty || save.isPending} onClick={() => setDraft(saved)}>
          Discard
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty || save.isPending || draft === null}
          onClick={() => draft && save.mutate(draft)}
        >
          <Icon name="check" size={14} />
          {save.isPending ? 'Saving…' : 'Save adjustments'}
        </button>
      </div>
    </div>
  );
}

// ── Role card ────────────────────────────────────────────────────────────────

function RoleCard({
  role, tree, busy, readOnly, onSave, onDelete,
}: {
  role: RoleRecord;
  tree: PermNode[];
  busy: boolean;
  readOnly: boolean;
  onSave: (permissions: PermMap) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PermMap>(role.permissions);
  const [confirming, setConfirming] = useState(false);

  // A save (or somebody else's) refreshes the role; follow it unless the
  // operator is mid-edit, in which case their draft is the newer truth.
  useEffect(() => {
    setDraft((d) => (same(d, role.permissions) || !open ? role.permissions : d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role.permissions]);

  const dirty = !same(draft, role.permissions);
  const granted = Object.values(role.permissions).reduce((n, g) => n + Object.keys(g).length, 0);

  return (
    <section className={`card role-card${open ? ' is-open' : ''}`}>
      <div
        className="card-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <div className="role-head-main">
          <Icon name={open ? 'chev-d' : 'chev-r'} size={14} />
          {role.is_system && <Icon name="lock" size={12} />}
          <h3 className="card-title">{role.label}</h3>
          <code className="rolecode">{role.code}</code>
          {role.description && <span className="role-sub">{role.description}</span>}
        </div>
        <div className="role-actions" onClick={(e) => e.stopPropagation()}>
          <span className="faint">
            {role.user_count === 0 ? 'No users' : `${role.user_count} user${role.user_count === 1 ? '' : 's'}`}
            {' · '}
            {granted === 0 ? 'nothing granted' : `${granted} setting${granted === 1 ? '' : 's'}`}
          </span>
          {!readOnly && (role.is_system ? (
            <span className="faint" title="Built-in roles are referenced by the seed and by migrations">
              Built-in
            </span>
          ) : confirming ? (
            <span className="confirm-row">
              <button type="button" className="linkbtn" onClick={() => setConfirming(false)}>Cancel</button>
              <button type="button" className="linkbtn is-danger" disabled={busy}
                onClick={() => { onDelete(); setConfirming(false); }}>Confirm</button>
            </span>
          ) : (
            <button type="button" className="linkbtn is-danger" disabled={busy}
              title={role.user_count > 0 ? 'Move its users to another role first' : 'Delete this role'}
              onClick={() => setConfirming(true)}>Delete</button>
          ))}
        </div>
      </div>

      {open && (
        <div className="role-body">
          <PermissionMatrix tree={tree} value={draft} onChange={setDraft} disabled={busy || readOnly} />
          {!readOnly && (
            <div className="role-save">
              <span className="faint">{dirty ? 'Unsaved changes' : 'Saved'}</span>
              <button type="button" className="btn" disabled={!dirty || busy} onClick={() => setDraft(role.permissions)}>
                Discard
              </button>
              <button type="button" className="btn btn-primary" disabled={!dirty || busy} onClick={() => onSave(draft)}>
                <Icon name="check" size={14} />
                {busy ? 'Saving…' : 'Save role'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ── Forms ────────────────────────────────────────────────────────────────────

function InviteForm({ roles, busy, onCancel, onSubmit }: {
  roles: RoleRecord[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (v: { email: string; name: string; role: string; is_super_admin: boolean }) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [superAdmin, setSuperAdmin] = useState(false);

  const effectiveRole = role || roles[0]?.code || '';
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const valid = emailOk && name.trim().length > 0 && effectiveRole !== '';

  return (
    <section className="card adm-form">
      <div className="card-head">
        <h3 className="card-title">Invite a user</h3>
        <span className="card-meta"><span className="req" aria-hidden="true">*</span> required</span>
      </div>
      <div className="card-pad">
        <div className="frow">
          <div className="field">
            <label className="lbl" htmlFor="inv-email">Work email <span className="req">*</span></label>
            <input className="fld" id="inv-email" type="email" placeholder="name@byblosvista.com"
              value={email} onChange={(e) => setEmail(e.target.value)} />
            <span className="hint">Must match their Microsoft account exactly — this is what sign-in checks.</span>
          </div>
          <div className="field">
            <label className="lbl" htmlFor="inv-name">Full name <span className="req">*</span></label>
            <input className="fld" id="inv-name" type="text" placeholder="Jeff Sanders"
              value={name} onChange={(e) => setName(e.target.value)} />
            <span className="hint">Microsoft replaces this with their directory name on first sign-in.</span>
          </div>
        </div>
        <div className="frow">
          <div className="field">
            <label className="lbl" htmlFor="inv-role">Role</label>
            <select className="fld" id="inv-role" value={effectiveRole} onChange={(e) => setRole(e.target.value)}>
              {roles.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
          </div>
          <div className="field">
            <span className="lbl">Super admin</span>
            <label className="sw">
              <input type="checkbox" checked={superAdmin} onChange={(e) => setSuperAdmin(e.target.checked)} />
              <span className="sw-track" aria-hidden="true" />
              <span>Every permission, the admin console, and view as anyone</span>
            </label>
          </div>
        </div>
        <div className="sheet-f">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!valid || busy}
            onClick={() => onSubmit({ email: email.trim(), name: name.trim(), role: effectiveRole, is_super_admin: superAdmin })}>
            <Icon name="user-plus" size={14} />
            {busy ? 'Inviting…' : 'Send invitation'}
          </button>
        </div>
      </div>
    </section>
  );
}

function RoleForm({ roles, tree, busy, onCancel, onSubmit }: {
  roles: RoleRecord[];
  tree: PermNode[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (v: { label: string; description: string | null; permissions: PermMap }) => void;
}) {
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [permissions, setPermissions] = useState<PermMap>({});
  const [copyFrom, setCopyFrom] = useState('');

  const valid = label.trim().length >= 2;
  // Mirrors the server's normalizeCode so the operator sees the identifier they
  // will actually get before they commit to it.
  const code = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  return (
    <section className="card adm-form">
      <div className="card-head">
        <h3 className="card-title">New role</h3>
        <span className="card-meta">Assignable immediately after saving</span>
      </div>
      <div className="card-pad">
        <div className="frow">
          <div className="field">
            <label className="lbl" htmlFor="role-label">Name <span className="req">*</span></label>
            <input className="fld" id="role-label" type="text" placeholder="Regional Manager"
              value={label} onChange={(e) => setLabel(e.target.value)} />
            <span className="hint">
              Code: <code className="rolecode">{code || '—'}</code> — generated from the name, stored on each user.
            </span>
          </div>
          <div className="field">
            <label className="lbl" htmlFor="role-desc">Description <span className="opt">optional</span></label>
            <input className="fld" id="role-desc" type="text" placeholder="What this role is responsible for"
              value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>

        <div className="frow">
          <div className="field">
            <label className="lbl" htmlFor="role-copy">Start from</label>
            <select
              className="fld"
              id="role-copy"
              value={copyFrom}
              onChange={(e) => {
                setCopyFrom(e.target.value);
                const src = roles.find((r) => r.code === e.target.value);
                setPermissions(src ? { ...src.permissions } : {});
              }}
            >
              <option value="">Nothing — grant from scratch</option>
              {roles.map((r) => <option key={r.code} value={r.code}>Copy of {r.label}</option>)}
            </select>
            <span className="hint">Copies that role’s settings as a starting point; the two stay independent afterwards.</span>
          </div>
        </div>

        <div className="field">
          <span className="lbl">Permissions</span>
          <PermissionMatrix tree={tree} value={permissions} onChange={setPermissions} disabled={busy} />
        </div>

        <div className="sheet-f">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!valid || busy}
            onClick={() => onSubmit({ label: label.trim(), description: description.trim() || null, permissions })}>
            <Icon name="plus" size={14} />
            {busy ? 'Creating…' : 'Create role'}
          </button>
        </div>
      </div>
    </section>
  );
}
