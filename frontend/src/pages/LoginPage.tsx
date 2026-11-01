import { useEffect, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Button } from '../components/Button';
import { Notice } from '../components/feedback';
import { TextField } from '../components/fields';
import { PageFallback } from '../components/PageFallback';
import { safeRedirectPath } from '../lib/redirect';
import { useAuth } from '../stores/auth';

/** `location.state.from`, set by RequireAuth when it sent the user here. */
function requestedPath(state: unknown): unknown {
  return typeof state === 'object' && state !== null && 'from' in state ? state.from : undefined;
}

export default function LoginPage() {
  const status = useAuth((state) => state.status);
  const checkSession = useAuth((state) => state.checkSession);
  const signIn = useAuth((state) => state.signIn);
  const loginPending = useAuth((state) => state.loginPending);
  const loginError = useAuth((state) => state.loginError);
  const notice = useAuth((state) => state.notice);
  const location = useLocation();

  useEffect(() => {
    if (status === 'unknown') void checkSession();
  }, [status, checkSession]);

  if (status === 'authenticated') return <Navigate to={safeRedirectPath(requestedPath(location.state))} replace />;
  if (status === 'unknown' || status === 'checking') return <PageFallback />;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void signIn(String(form.get('email') ?? ''), String(form.get('password') ?? ''));
  };

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="space-y-1">
          <p className="font-bold text-emerald-800">Supermarket Stock</p>
          <h1 className="text-2xl font-semibold">Sign in</h1>
        </div>
        {notice !== null && (
          <Notice tone="warning" role="status" testId="login-notice">
            {notice}
          </Notice>
        )}
        <form onSubmit={onSubmit} className="space-y-4" data-testid="login-form">
          <TextField label="Email" name="email" type="email" autoComplete="username" required testId="login-email" />
          <TextField
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            testId="login-password"
          />
          {loginError !== null && (
            <Notice tone="error" role="alert" testId="login-error">
              {loginError}
            </Notice>
          )}
          <Button type="submit" pending={loginPending} className="w-full" data-testid="login-submit">
            {loginPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </main>
  );
}
