/* /sign-in — the only route reachable without a session.
   Always the production layout — the wordmark and one "Sign in with
   Microsoft" button — so what is seen in development is what ships:
     entra   → the button starts the real Microsoft round trip
     bypass  → the button signs in as DEV_DEFAULT_EMAIL with no password; a
               footnote says so and can reveal the full account picker for
               testing other roles */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { LOGO } from '../lib/brand';
import { useAuth } from '../auth/AuthProvider';
import { Icon, IconSprite, type IconName } from '../components/Icon';
import { devSignIn, listDevCandidates, startMicrosoftSignIn } from '../api/client';
import { initialsOf, roleLabel } from '../lib/actor';

/** Who the Microsoft button signs in as under the dev bypass. Falls back to the
    first super admin, then the first account, if this address is not seeded. */
const DEV_DEFAULT_EMAIL = 'eliseam@byblosvista.com';

/** Where a sign-in lands when nothing more specific was asked for. */
const HOME = '/dashboard';

/** The page to return to after sign-in: the ?redirect_to RequireAuth set when
    it bounced someone here, if it is a same-origin path — never an absolute
    URL, so the parameter cannot be abused to send people off-site. A bare "/"
    means nobody asked for anything in particular (they just opened the app),
    so that lands on HOME too. */
function landingFrom(params: URLSearchParams): string {
  const to = params.get('redirect_to');
  return to && to !== '/' && to.startsWith('/') && !to.startsWith('//') ? to : HOME;
}

export function SignInPage() {
  const { authMode, refresh, loading } = useAuth();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  // The route's stops follow the pointer a little (see .signin-stop). Two
  // unitless numbers in -1..1 on the page element; CSS turns them into a
  // per-stop offset. Nothing runs when the pointer is still, and nothing at
  // all for anyone who asked the OS for less motion or has no pointer.
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia('(pointer: fine)').matches) return;
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (((e.clientX - r.left) / r.width - 0.5) * 2).toFixed(3));
      el.style.setProperty('--my', (((e.clientY - r.top) / r.height - 0.5) * 2).toFixed(3));
    };
    el.addEventListener('mousemove', onMove);
    return () => el.removeEventListener('mousemove', onMove);
  }, []);

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
    if (authenticated) window.location.replace(landingFrom(params));
  }, [authenticated, params]);

  const devUsers = candidates.data?.items ?? [];
  const devDefault =
    devUsers.find((u) => u.email?.toLowerCase() === DEV_DEFAULT_EMAIL) ??
    devUsers.find((u) => u.is_super_admin) ??
    devUsers[0];

  async function pick(id: string) {
    setBusy(id);
    setLocalError(null);
    try {
      await devSignIn(id);
      await refresh();
      window.location.replace(landingFrom(params));
    } catch (err) {
      setLocalError((err as Error).message || 'Could not sign in as that user.');
      setBusy(null);
    }
  }

  return (
    <div className="signin" ref={pageRef}>
      <IconSprite />
      {/* The brand's route — the line with stops from the wordmark — drawn
          across the whole page behind the card and traced in on load. The
          three stops are the product's three pillars in order (work orders →
          quotes → payments), placed outside the card's footprint so they stay
          visible: upper-left, below, upper-right. Purely atmospheric; hidden
          from AT. Each stop is two groups: the outer one carries the pointer
          offset, the inner one the entrance pop, so neither transform clobbers
          the other. */}
      <svg
        className="signin-route"
        viewBox="0 0 1440 900"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
        focusable="false"
      >
        <path
          className="signin-route-line"
          pathLength={1}
          d="M-60 560 C140 560 230 260 420 290 C610 320 640 700 860 690 C1080 680 1100 260 1290 280 C1480 300 1500 560 1600 540"
        />
        <g className="signin-route-stops">
          {ROUTE_STOPS.map((stop) => (
            <g key={stop.icon} className="signin-stop" style={{ '--depth': stop.depth } as CSSProperties}>
              <g className="signin-stop-in">
                <circle cx={stop.x} cy={stop.y} r={20} />
                <svg
                  className="signin-stop-icon"
                  x={stop.x - 10}
                  y={stop.y - 10}
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                >
                  <use href={`#i-${stop.icon}`} />
                </svg>
              </g>
            </g>
          ))}
        </g>
      </svg>
      <div className="signin-card">
        {/* The wordmark IS the heading — it already says "the One". The h1 stays
            for assistive tech and the document outline; it is just not drawn. */}
        <div className="signin-logo">
          <img src={LOGO} alt="" />
        </div>
        <h1 className="signin-title u-sr-only">The One</h1>

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

        {!loading && (authMode === 'entra' || authMode === 'bypass') && (
          <>
            <button
              type="button"
              className="signin-ms"
              disabled={busy !== null || (authMode === 'bypass' && !devDefault)}
              onClick={() =>
                authMode === 'entra'
                  ? startMicrosoftSignIn(landingFrom(params))
                  : devDefault && pick(devDefault.id)
              }
            >
              <MicrosoftMark />
              {busy && busy === devDefault?.id ? 'Signing in…' : 'Sign in with Microsoft'}
            </button>
          </>
        )}

        {!loading && authMode === 'bypass' && (
          <>
            <div className="signin-dev">
              <Icon name="alert" size={12} />
              <span>
                <b>Development mode.</b> Microsoft is not configured, so the button above signs
                you in as <b>{devDefault?.email ?? '…'}</b> with no password. Never run this on a
                server.
                {candidates.isError && ' Could not reach the API — is it running on :5174?'}
                {devUsers.length > 1 && (
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => setShowPicker((v) => !v)}
                  >
                    {showPicker ? 'Hide other accounts' : 'Sign in as someone else'}
                  </button>
                )}
              </span>
            </div>

            {showPicker && (
              <ul className="signin-users">
                {devUsers.map((u) => (
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
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Where the route's stops sit (viewBox units — each is a segment end of the
    path above) and how far each drifts with the pointer. Depth differs per stop
    so the drift reads as parallax rather than the whole group sliding. */
const ROUTE_STOPS: { x: number; y: number; icon: IconName; depth: string }[] = [
  { x: 420, y: 290, icon: 'wrench', depth: '22px' },
  { x: 860, y: 690, icon: 'file', depth: '14px' },
  { x: 1290, y: 280, icon: 'user-cog', depth: '28px' },
];

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
