import { NavLink, Outlet } from 'react-router';
import type { Role } from '../api/types';
import { useAuth } from '../stores/auth';
import { Button } from './Button';
import { Notice } from './feedback';
import { RouteBoundary } from './RouteBoundary';

interface NavItem {
  to: string;
  label: string;
  /** Only this role sees the link; every signed-in user when absent. */
  role?: Role;
  /** Highlight only on an exact match (so /stock-movements/new does not highlight the history). */
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Products', end: true },
  { to: '/stock-movements/new', label: 'Record movement' },
  { to: '/stock-movements', label: 'History', end: true },
  { to: '/categories', label: 'Categories', role: 'admin' },
  { to: '/employees', label: 'Employees', role: 'admin' },
];

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 ${
    isActive ? 'bg-emerald-50 text-emerald-800' : 'text-slate-700 hover:bg-slate-100'
  }`;

export function Layout() {
  const user = useAuth((state) => state.user);
  const signOut = useAuth((state) => state.signOut);
  const logoutPending = useAuth((state) => state.logoutPending);
  const logoutError = useAuth((state) => state.logoutError);
  const items = NAV_ITEMS.filter((item) => item.role === undefined || item.role === user?.role);

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only rounded-lg bg-white px-3 py-2 font-semibold focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10"
      >
        Skip to content
      </a>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl space-y-2 px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 leading-tight">
              <span className="block text-lg font-bold text-emerald-800">Supermarket Stock</span>
              <span className="block truncate text-sm text-slate-600" data-testid="current-user">
                {user?.fullName} · {user?.role === 'admin' ? 'Administrator' : 'Employee'}
              </span>
            </div>
            <Button variant="secondary" pending={logoutPending} onClick={() => void signOut()} data-testid="sign-out">
              Sign out
            </Button>
          </div>
          <nav aria-label="Main" className="-mx-1 overflow-x-auto">
            <ul className="flex gap-1 px-1 pb-1">
              {items.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.end} className={navLinkClass}>
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      {logoutError !== null && (
        <div className="mx-auto mt-4 max-w-5xl px-4">
          <Notice tone="error" role="alert">
            Could not sign out: {logoutError}
          </Notice>
        </div>
      )}
      <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-6 focus:outline-none">
        <RouteBoundary>
          <Outlet />
        </RouteBoundary>
      </main>
    </div>
  );
}
