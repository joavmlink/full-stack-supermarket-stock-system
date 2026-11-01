import type { StoreApi } from 'zustand/vanilla';
import type { AuthState } from './auth-store';

/**
 * Everything loaded or being written belongs to the user who is signed in.
 * When that changes (sign-out, a lost session, someone else signing in), every
 * `reset` runs: data is cleared and the writes still retrying stop, so a retry
 * never runs under the next user's session. Returns the unsubscribe.
 */
export function resetOnUserChange(auth: StoreApi<AuthState>, resets: (() => void)[]): () => void {
  let userId = auth.getState().user?.id ?? null;
  return auth.subscribe(({ user }) => {
    const next = user?.id ?? null;
    if (next === userId) return;
    userId = next;
    for (const reset of resets) reset();
  });
}
