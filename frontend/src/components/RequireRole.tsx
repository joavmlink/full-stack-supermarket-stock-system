import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Role } from '../api/types';
import { useAuth } from '../stores/auth';
import { textLinkClass } from './feedback';

/** Inside RequireAuth: renders its children only for the given role. */
export function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const userRole = useAuth((state) => state.user?.role);
  if (userRole === role) return children;
  return (
    <section data-testid="forbidden" className="space-y-3">
      <h1 className="text-2xl font-semibold">Access denied</h1>
      <p className="text-slate-600">Your account cannot open this page.</p>
      <Link to="/" className={textLinkClass}>
        Go to products
      </Link>
    </section>
  );
}
