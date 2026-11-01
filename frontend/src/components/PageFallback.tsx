import { useDelayedFlag } from '../hooks/use-delayed-flag';
import { Spinner } from './Spinner';

/** The Suspense fallback: announced to screen readers at once, visible only if loading takes a while. */
export function PageFallback() {
  const visible = useDelayedFlag(true);
  return (
    <div role="status" data-testid="page-loading" className="flex min-h-48 items-center justify-center gap-3 p-8 text-slate-600">
      {visible && <Spinner className="size-6" />}
      <span className={visible ? '' : 'sr-only'}>Loading…</span>
    </div>
  );
}
