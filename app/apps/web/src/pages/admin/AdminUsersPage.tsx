/* Admin › Users and Admin › Roles — two sections, one module.
     Users  · who exists, what role they hold, whether they can sign in
     Roles  · what roles exist, what each may do, and creating new ones

   They used to share one page behind a Users/Roles toggle. Each is now its own
   route so the Admin rail lists them side by side (Users first) and each one
   is seen alone. The tables and forms below are shared as before. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from './AdminShell';
import { Icon } from '../../components/Icon';
import { useAuth } from '../../auth/AuthProvider';
import {
  createRole,
  deleteRole,
  inviteUser,
  listAdminUsers,
  listRoles,
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

// ── Admin › Users ────────────────────────────────────────────────────────────

export function AdminUsersPage() {
  const { user } = useAuth();
  const { fail, done, strip } = useAdminFeedback();
  const [inviteOpen, setInviteOpen] = useState(false);

  const isAdmin = Boolean(user?.is_super_admin);
  const usersQuery = useQuery({ queryKey: ['admin-users'], queryFn: listAdminUsers, enabled: isAdmin, retry: 0 });
  // Roles feed the role <select> on every row and in the invite form.
  const rolesQuery = useQuery({ queryKey: ['admin-roles'], queryFn: listRoles, enabled: isAdmin, retry: 0 });

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

      <div className="callout" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span>
          Sign-in is <b>invitation only</b>. Adding somebody here <i>is</i> the invitation —
          there is no email to send. They sign in with the Microsoft account matching the
          address below, and nobody who is not on this list can get in.
        </span>
      </div>

      <div className="toolbar">
        <button type="button" className="btn btn-primary" onClick={() => setInviteOpen((v) => !v)}>
          <Icon name="user-plus" size={14} />
          Invite a user
        </button>
      </div>

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
        busy={patchUser.isPending}
        onChange={(id, input) => patchUser.mutate({ id, input })}
      />
    </AdminShell>
  );
}

// ── Admin › Roles ────────────────────────────────────────────────────────────

export function AdminRolesPage() {
  const { user } = useAuth();
  const { fail, done, strip } = useAdminFeedback();
  const [newRoleOpen, setNewRoleOpen] = useState(false);

  const isAdmin = Boolean(user?.is_super_admin);
  const rolesQuery = useQuery({ queryKey: ['admin-roles'], queryFn: listRoles, enabled: isAdmin, retry: 0 });
  const roles = rolesQuery.data?.items ?? [];

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
      subtitle={`${roles.length} role${roles.length === 1 ? '' : 's'} · capabilities here are the ones the server actually enforces`}
    >
      {strip}

      <div className="toolbar">
        <button type="button" className="btn btn-primary" onClick={() => setNewRoleOpen((v) => !v)}>
          <Icon name="plus" size={14} />
          New role
        </button>
      </div>

      {newRoleOpen && (
        <RoleForm
          busy={addRole.isPending}
          onCancel={() => setNewRoleOpen(false)}
          onSubmit={(v) => addRole.mutate(v)}
        />
      )}

      <RolesTable
        items={roles}
        loading={rolesQuery.isLoading}
        error={rolesQuery.isError}
        busy={patchRole.isPending || removeRole.isPending}
        onChange={(id, input) => patchRole.mutate({ id, input })}
        onDelete={(id) => removeRole.mutate(id)}
      />
    </AdminShell>
  );
}

// ── Users table ──────────────────────────────────────────────────────────────

function UsersTable({
  items, roles, selfId, loading, error, busy, onChange,
}: {
  items: AdminUserItem[];
  roles: RoleRecord[];
  selfId?: string;
  loading: boolean;
  error: boolean;
  busy: boolean;
  onChange: (id: string, input: { role?: string; is_super_admin?: boolean; status?: UserStatus }) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="ct">
        <thead>
          <tr>
            <th>User</th><th>Role</th><th>Status</th><th>Super admin</th>
            <th>Last sign-in</th><th />
          </tr>
        </thead>
        <tbody>
          {loading && <tr className="ct-empty"><td colSpan={6}>Loading users…</td></tr>}
          {error && !loading && (
            <tr className="ct-empty"><td colSpan={6}>Could not load users. Is the API running on :5174?</td></tr>
          )}
          {items.map((u) => {
            const isSelf = u.id === selfId;
            const status = STATUS_COPY[u.status];
            const off = u.status === 'disabled';
            return (
              <tr key={u.id} className={off ? 'is-dim' : undefined}>
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
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Roles table ──────────────────────────────────────────────────────────────

function RolesTable({
  items, loading, error, busy, onChange, onDelete,
}: {
  items: RoleRecord[];
  loading: boolean;
  error: boolean;
  busy: boolean;
  onChange: (id: string, input: Parameters<typeof updateRole>[1]) => void;
  onDelete: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <div className="table-wrap">
      <table className="ct">
        <thead>
          <tr>
            <th>Role</th>
            <th className="num">Users</th>
            <th className="pcol">Build quotes</th>
            <th className="pcol">Approve &amp; send</th>
            <th className="pcol">Manage users</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {loading && <tr className="ct-empty"><td colSpan={6}>Loading roles…</td></tr>}
          {error && !loading && <tr className="ct-empty"><td colSpan={6}>Could not load roles.</td></tr>}
          {items.map((r) => (
            <tr key={r.id}>
              <td>
                <div className="site">
                  <strong>
                    {r.is_system && <Icon name="lock" size={12} />}
                    {r.label}
                    <code className="rolecode">{r.code}</code>
                  </strong>
                  <small>{r.description ?? '—'}</small>
                </div>
              </td>
              <td className="num">{r.user_count || '—'}</td>
              <Cap on={r.can_edit_quote} busy={busy} label={`${r.label} can build quotes`}
                onToggle={(v) => onChange(r.id, { can_edit_quote: v })} />
              <Cap on={r.can_approve_quote} busy={busy} label={`${r.label} can approve quotes`}
                onToggle={(v) => onChange(r.id, { can_approve_quote: v })} />
              <Cap on={r.can_manage_users} busy={busy} label={`${r.label} can manage users`}
                onToggle={(v) => onChange(r.id, { can_manage_users: v })} />
              <td className="num">
                {r.is_system ? (
                  <span className="faint" title="Built-in roles are referenced by the seed and by migrations">
                    Built-in
                  </span>
                ) : confirming === r.id ? (
                  <span className="confirm-row">
                    <button type="button" className="linkbtn" onClick={() => setConfirming(null)}>Cancel</button>
                    <button type="button" className="linkbtn is-danger" disabled={busy}
                      onClick={() => { onDelete(r.id); setConfirming(null); }}>Confirm</button>
                  </span>
                ) : (
                  <button type="button" className="linkbtn is-danger" disabled={busy}
                    title={r.user_count > 0 ? 'Move its users to another role first' : 'Delete this role'}
                    onClick={() => setConfirming(r.id)}>Delete</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cap({ on, busy, label, onToggle }: {
  on: boolean; busy: boolean; label: string; onToggle: (v: boolean) => void;
}) {
  return (
    <td className="pcell">
      <label className="sw sm">
        <input type="checkbox" checked={on} disabled={busy} aria-label={label}
          onChange={(e) => onToggle(e.target.checked)} />
        <span className="sw-track" aria-hidden="true" />
      </label>
    </td>
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
              <span>Can manage users and view as anyone</span>
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

function RoleForm({ busy, onCancel, onSubmit }: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (v: {
    label: string; description: string | null;
    can_edit_quote: boolean; can_approve_quote: boolean; can_manage_users: boolean;
  }) => void;
}) {
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [edit, setEdit] = useState(false);
  const [approve, setApprove] = useState(false);
  const [manage, setManage] = useState(false);

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

        <div className="field">
          <span className="lbl">Capabilities</span>
          <span className="hint" style={{ marginBottom: 8 }}>
            Only the three gates the server enforces today. More appear here as modules land — a
            checkbox for a permission nothing checks would be worse than none.
          </span>
          <div className="cap-list">
            <CapRow on={edit} set={setEdit} title="Build and edit quotes"
              note="Create a draft, add line items, submit for approval." />
            <CapRow on={approve} set={setApprove} title="Approve and send quotes"
              note="Approve, reject with a note, push the summary to the client CMMS." />
            <CapRow on={manage} set={setManage} title="Manage users"
              note="Full access to this admin console." />
          </div>
        </div>

        <div className="sheet-f">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!valid || busy}
            onClick={() => onSubmit({
              label: label.trim(),
              description: description.trim() || null,
              can_edit_quote: edit, can_approve_quote: approve, can_manage_users: manage,
            })}>
            <Icon name="plus" size={14} />
            {busy ? 'Creating…' : 'Create role'}
          </button>
        </div>
      </div>
    </section>
  );
}

function CapRow({ on, set, title, note }: {
  on: boolean; set: (v: boolean) => void; title: string; note: string;
}) {
  return (
    <label className="cap-row">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span className="sw-track" aria-hidden="true" />
      <span className="cap-text">
        <b>{title}</b>
        <small>{note}</small>
      </span>
    </label>
  );
}
