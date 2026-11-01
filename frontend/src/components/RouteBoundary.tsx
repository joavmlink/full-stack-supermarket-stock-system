import { Suspense, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { ErrorBoundary } from './ErrorBoundary';
import { PageFallback } from './PageFallback';

/**
 * Around one page: its chunk loads inside it (the header stays on screen), and
 * an error shows the recovery screen in its place. A new key on every route
 * change resets the boundary, without remounting the layout around it.
 */
export function RouteBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary key={pathname}>
      <Suspense fallback={<PageFallback />}>{children}</Suspense>
    </ErrorBoundary>
  );
}
