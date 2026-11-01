import { useCallback, useLayoutEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Sets some search params ('' removes one) on top of the URL as it is now.
 * React Router's `setSearchParams(fn)` builds on the params of the last
 * render, so a delayed update (a debounced search) could bring back an older
 * URL and drop a newer change; this always starts from the latest one.
 */
export function useUpdateSearchParams() {
  const [params, setParams] = useSearchParams();
  const latest = useRef(params);
  const setLatest = useRef(setParams);
  useLayoutEffect(() => {
    latest.current = params;
    setLatest.current = setParams;
  });
  return useCallback(
    (changes: Record<string, string>, { replace }: { replace: boolean }) => {
      const next = new URLSearchParams(latest.current);
      for (const [key, value] of Object.entries(changes)) {
        if (value === '') next.delete(key);
        else next.set(key, value);
      }
      if (next.toString() === latest.current.toString()) return;
      latest.current = next;
      setLatest.current(next, { replace });
    },
    // Stable: effects that depend on it run only when their own inputs change.
    [],
  );
}
