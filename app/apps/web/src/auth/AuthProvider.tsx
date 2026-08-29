// Session state for the whole app — one source of truth for "who am I".
//
// Replaces lib/actor.ts, which pinned an arbitrary principal id in localStorage
// and sent it as a header. Identity now lives in an httpOnly cookie the browser
// cannot read, so the only way to learn it is to ask the server.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  getMe,
  setUnauthorizedHandler,
  signOut as apiSignOut,
  startImpersonating as apiStartImpersonating,
  stopImpersonating as apiStopImpersonating,
  type AuthMode,
  type MeResponse,
  type SessionUser,
} from '../api/client';

interface AuthState {
  loading: boolean;
  authenticated: boolean;
  authMode: AuthMode;
  /** The human who signed in. Admin rights are always read from this. */
  user: SessionUser | null;
  /** Who the app behaves as — differs from `user` only while impersonating. */
  actingAs: SessionUser | null;
  isImpersonating: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  impersonate: (principalId: string) => Promise<void>;
  stopImpersonating: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const EMPTY: MeResponse = {
  authenticated: false,
  auth_mode: 'bypass',
  user: null,
  acting_as: null,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse>(EMPTY);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await getMe());
    } catch {
      // A network failure is not a signed-out user, but from the UI's point of
      // view there is nothing useful to render either way.
      setMe(EMPTY);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Any 401 from any call anywhere collapses the session immediately, so a
  // disabled account stops seeing stale data on the very next request.
  useEffect(() => {
    setUnauthorizedHandler(() => setMe(EMPTY));
    return () => setUnauthorizedHandler(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      authenticated: me.authenticated,
      authMode: me.auth_mode,
      user: me.user,
      actingAs: me.acting_as ?? me.user,
      isImpersonating: Boolean(me.is_impersonating),
      refresh,
      signOut: async () => {
        const res = await apiSignOut().catch(() => null);
        setMe(EMPTY);
        // Ending our session but not Microsoft's makes "sign out, sign in" look
        // broken: it silently returns the same account.
        if (res?.microsoft_logout_url) {
          window.location.href = res.microsoft_logout_url;
        } else {
          window.location.href = '/sign-in';
        }
      },
      impersonate: async (principalId: string) => {
        await apiStartImpersonating(principalId);
        await refresh();
      },
      stopImpersonating: async () => {
        await apiStopImpersonating();
        await refresh();
      },
    }),
    [loading, me, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Convenience for the many places that only care about the effective role. */
export function useActingRole(): string | null {
  return useAuth().actingAs?.role ?? null;
}
