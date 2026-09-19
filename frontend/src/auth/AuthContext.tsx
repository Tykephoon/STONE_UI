/**
 * Session state for the SPA.
 *
 * This context is a *user-experience* mechanism: it decides what to render and
 * where to redirect. It is not a security boundary. The backend re-derives the
 * caller's identity from the session cookie on every single request and scopes
 * every query by it, so a user who forces this context into a signed-in state
 * gains exactly nothing.
 *
 * No token is stored here or anywhere else in JavaScript. The session lives in
 * an httpOnly cookie the page cannot read.
 */
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as authApi from '../api/auth';
import { ApiError, onSessionExpired } from '../api/client';
import type { User } from '../api/types';
import { config } from '../config';

export type AuthStatus = 'checking' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: { email: string; password: string; displayName?: string }) => Promise<void>;
  signOut: () => Promise<void>;
  signOutEverywhere: () => Promise<number>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [user, setUser] = useState<User | null>(null);

  /** Guards against a late in-flight check overwriting a newer sign-out. */
  const generation = useRef(0);

  const applySignedIn = useCallback((next: User) => {
    generation.current += 1;
    setUser(next);
    setStatus('authenticated');
  }, []);

  const applySignedOut = useCallback(() => {
    generation.current += 1;
    setUser(null);
    setStatus('anonymous');
  }, []);

  /**
   * Cold-start session probe.
   *
   * On a fresh page load the cookie may already be valid. `/api/auth/me` is the
   * only way to find out — the cookie is httpOnly, so its presence cannot be
   * tested from script.
   */
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();

    (async () => {
      try {
        const response = await authApi.me(controller.signal);
        if (generation.current !== current) return;
        setUser(response.user);
        setStatus('authenticated');
        // Recover the CSRF token for this session; it is needed before the
        // first mutating request.
        await authApi.bootstrapCsrf().catch(() => undefined);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        if (generation.current !== current) return;
        setUser(null);
        setStatus('anonymous');
      }
    })();

    return () => controller.abort();
  }, []);

  /**
   * Silent refresh, comfortably inside the server's sliding window.
   *
   * The API client also refreshes reactively on a 401; this proactive pass
   * means a user reading a dashboard for an hour never sees that happen.
   */
  useEffect(() => {
    if (status !== 'authenticated') return;

    const timer = setInterval(() => {
      authApi.refresh().catch((cause: unknown) => {
        // A failed refresh past the absolute cap means the session is over.
        if (cause instanceof ApiError && cause.status === 401) applySignedOut();
      });
    }, config.sessionRefreshIntervalMs);

    return () => clearInterval(timer);
  }, [status, applySignedOut]);

  /** The API client fires this when a request proves the session is gone. */
  useEffect(() => onSessionExpired(applySignedOut), [applySignedOut]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const next = await authApi.login({ email, password });
      applySignedIn(next);
    },
    [applySignedIn],
  );

  const signUp = useCallback(
    async (input: { email: string; password: string; displayName?: string }) => {
      const next = await authApi.register({
        email: input.email,
        password: input.password,
        ...(input.displayName ? { display_name: input.displayName } : {}),
      });
      applySignedIn(next);
    },
    [applySignedIn],
  );

  const signOut = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      // Sign out locally even if the request failed; the cookie may already be
      // dead, and leaving the UI in a signed-in state would be worse.
      applySignedOut();
    }
  }, [applySignedOut]);

  const signOutEverywhere = useCallback(async () => {
    try {
      const { revoked } = await authApi.logoutEverywhere();
      return revoked;
    } finally {
      applySignedOut();
    }
  }, [applySignedOut]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, signIn, signUp, signOut, signOutEverywhere }),
    [status, user, signIn, signUp, signOut, signOutEverywhere],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>.');
  }
  return context;
}
