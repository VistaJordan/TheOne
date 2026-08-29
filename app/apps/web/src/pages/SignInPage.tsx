/* /sign-in — the only route reachable without a session.
   Renders one of two things depending on how the API is configured:
     entra   → a single "Sign in with Microsoft" button
     bypass  → a picker of seeded users, with the risk stated plainly */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { LOGO } from '../lib/brand';
import { useAuth } from '../auth/AuthProvider';
import { Icon, IconSprite } from '../components/Icon';
import { devSignIn, listDevCandidates, startMicrosoftSignIn } from '../api/client';
import { initialsOf, roleLabel } from '../lib/actor';

export function SignInPage() {
  const { authMode, refresh, loading } = useAuth();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // The callback route redirects here with ?error= when sign-in fails, so the
  // person sees why rather than a blank form that "just didn't work".
  const error = params.get('error');
  const detail = params.get('detail');


  const candidates = useQuery({
    queryKey: ['dev-candidates'],
    queryFn: listDevCandidates,
    enabled: authMode === 'bypass',
    retry: 0,
  });

  // A signed-in visitor landing on /sign-in (bookmark, back button) belongs in
  // the app, not staring at a login form.
  const { authenticated } = useAuth();
  useEffect(() => {
    if (authenticated) window.location.replace('/');
  }, [authenticated]);

  async function pick(id: string) {
    setBusy(id);
    setLocalError(null);
    try {
      await devSignIn(id);
      await refresh();
      window.location.replace('/');
    } catch (err) {
      setLocalError((err as Error).message || 'Could not sign in as that user.');
      setBusy(null);
    }
  }

  return (
    <div className="signin">
      <IconSprite />
      <div className="signin-card">
        <img className="signin-logo" src={LOGO} alt="The One" />
        <h1 className="signin-title">The One</h1>
        <p className="signin-sub">Work orders, quotes and vendor payments in one place.</p>

        {(error || localError) && (
          <div className="signin-error" role="alert">
            <Icon name="alert" size={16} />
            <span>
              <b>{error ?? 'Sign-in failed'}</b>
              {(detail || localError) && <small>{detail ?? localError}</small>}
            </span>
          </div>
        )}

        {loading && <p className="signin-note">Checking your session…</p>}

        {!loading && authMode === 'entra' && (
          <>
            <button
              type="button"
              className="signin-ms"
              onClick={() => startMicrosoftSignIn(params.get('redirect_to') ?? '/')}
            >
              <MicrosoftMark />
              Sign in with Microsoft
            </button>
            <p className="signin-note">
              <Icon name="lock" size={12} />
              Access is by invitation. If your account has not been added yet, ask a super admin to
              invite your work address.
            </p>
          </>
        )}

        {!loading && authMode === 'bypass' && (
          <>
            <div className="signin-warn">
              <Icon name="alert" size={14} />
              <span>
                <b>Development sign-in.</b> Microsoft is not configured, so any account below can be
                used without a password. Never run this on a server.
              </span>
            </div>

            {candidates.isLoading && <p className="signin-note">Loading users…</p>}
            {candidates.isError && (
              <p className="signin-note">Could not reach the API. Is it running on :5174?</p>
            )}

            <ul className="signin-users">
              {(candidates.data?.items ?? []).map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    className="signin-user"
                    disabled={busy !== null}
                    onClick={() => pick(u.id)}
                  >
                    <span className="signin-avatar" aria-hidden="true">{initialsOf(u.name)}</span>
                    <span className="signin-user-meta">
                      <span className="signin-user-name">
                        {u.name}
                        {u.is_super_admin && <span className="signin-super">Super admin</span>}
                      </span>
                      <span className="signin-user-sub">
                        {u.email ?? '—'} · {roleLabel(u.role)}
                      </span>
                    </span>
                    {busy === u.id ? (
                      <Icon name="refresh" size={14} />
                    ) : (
                      <Icon name="arrow-r" size={14} />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/** The four-square Microsoft mark. Brand-mandated flat colours — not themed. */
function MicrosoftMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 23 23" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" fill="#f25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7fba00" />
      <rect x="1" y="12" width="10" height="10" fill="#00a4ef" />
      <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
    </svg>
  );
}
