import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../stores/auth';
import { ErrorState } from './ErrorState';
import { PageFallback } from './PageFallback';

/** Renders its children only for a signed-in user; anyone else goes to /login and comes back afterwards. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuth((state) => state.status);
  const checkError = useAuth((state) => state.checkError);
  const checkSession = useAuth((state) => state.checkSession);
  const signedOutByUser = useAuth((state) => state.signedOutByUser);
  const location = useLocation();

  useEffect(() => {
    if (status === 'unknown') void checkSession();
  }, [status, checkSession]);

  if (status === 'authenticated') return children;
  if (status === 'anonymous') {
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/login" replace state={signedOutByUser ? undefined : { from }} />;
  }
  if (status === 'error') {
    return (
      <main className="mx-auto max-w-md p-6">
        <ErrorState message={checkError ?? 'Could not check your session.'} onRetry={() => void checkSession()} />
      </main>
    );
  }
  return <PageFallback />;
}
