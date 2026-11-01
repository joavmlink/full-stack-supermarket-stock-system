import { useEffect, useRef } from 'react';
import { createScreenScope, type ScreenScope } from '../lib/screen-scope';

/**
 * A scope per mount: StrictMode's mount, unmount and mount again disposes the
 * first scope and creates a second one, so only the live screen continues.
 * Event handlers read `ref.current` when they start.
 */
export function useScreenScope(): { readonly current: ScreenScope } {
  const ref = useRef<ScreenScope>(createScreenScope());
  useEffect(() => {
    const scope = createScreenScope();
    ref.current = scope;
    return () => scope.dispose();
  }, []);
  return ref;
}
