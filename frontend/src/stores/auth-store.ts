import { createStore } from 'zustand/vanilla';
import type { AuthApi } from '../api/auth-api';
import { errorMessage } from '../api/errors';
import type { User } from '../api/types';

/**
 * - `unknown`: nothing checked yet (first render);
 * - `checking`: asking the API who is signed in;
 * - `error`: that check failed for a reason other than "not signed in".
 */
export type AuthStatus = 'unknown' | 'checking' | 'authenticated' | 'anonymous' | 'error';

export const SESSION_EXPIRED_NOTICE = 'Your session has ended. Please sign in again.';

export interface AuthState {
  status: AuthStatus;
  user: User | null;
  checkError: string | null;
  /** Shown on the sign-in screen after a session ends unexpectedly. */
  notice: string | null;
  /**
   * The user pressed "Sign out": the next sign-in starts at home instead of
   * the page they left (someone else may be signing in next).
   */
  signedOutByUser: boolean;
  loginPending: boolean;
  loginError: string | null;
  logoutPending: boolean;
  logoutError: string | null;

  /** Asks the API for the current user; concurrent calls share one request. */
  checkSession(): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** The API answered 401 UNAUTHENTICATED to some request. */
  sessionExpired(): void;
}

type Data = Omit<AuthState, 'checkSession' | 'signIn' | 'signOut' | 'sessionExpired'>;

const signedOut: Data = {
  status: 'anonymous',
  user: null,
  checkError: null,
  notice: null,
  signedOutByUser: false,
  loginPending: false,
  loginError: null,
  logoutPending: false,
  logoutError: null,
};

export function createAuthStore(api: AuthApi) {
  // Every change of who is signed in starts a new generation; a response that
  // belongs to an older one is stale and ignored (a check that resolves after
  // a sign-in, a sign-in that resolves after the session expired, ...).
  let generation = 0;
  /** The check in flight, shared by concurrent callers; cleared once it settles. */
  let pendingCheck: { generation: number; promise: Promise<void> } | null = null;

  return createStore<AuthState>()((set, get) => ({
    ...signedOut,
    status: 'unknown',

    checkSession() {
      if (pendingCheck?.generation === generation) return pendingCheck.promise;
      const ticket = ++generation;
      set({ status: 'checking', checkError: null });
      const promise = api
        .session()
        .then(
          (user) => {
            if (ticket === generation) set({ status: user === null ? 'anonymous' : 'authenticated', user });
          },
          (error: unknown) => {
            if (ticket === generation) set({ status: 'error', checkError: errorMessage(error) });
          },
        )
        .finally(() => {
          if (pendingCheck?.promise === promise) pendingCheck = null;
        });
      pendingCheck = { generation: ticket, promise };
      return promise;
    },

    async signIn(email, password) {
      if (get().loginPending) return;
      const ticket = ++generation;
      set({ loginPending: true, loginError: null, notice: null });
      try {
        const user = await api.login(email, password);
        if (ticket === generation) set({ ...signedOut, status: 'authenticated', user });
      } catch (error) {
        if (ticket === generation) set({ loginPending: false, loginError: errorMessage(error) });
      }
    },

    async signOut() {
      if (get().logoutPending) return;
      const ticket = generation;
      set({ logoutPending: true, logoutError: null });
      try {
        await api.logout();
        if (ticket === generation) {
          generation++;
          set({ ...signedOut, signedOutByUser: true });
        }
      } catch (error) {
        if (ticket === generation) set({ logoutPending: false, logoutError: errorMessage(error) });
      }
    },

    sessionExpired() {
      const wasSignedIn = get().status === 'authenticated';
      generation++;
      set({ ...signedOut, notice: wasSignedIn ? SESSION_EXPIRED_NOTICE : null });
    },
  }));
}
