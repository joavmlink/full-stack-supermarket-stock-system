import { useEffect, useState } from 'react';

/** Loading indicators appear only after this delay, so fast loads do not flash them. */
const INDICATOR_DELAY_MS = 300;

/** True once `active` has stayed true for that delay; false again as soon as it stops. */
export function useDelayedFlag(active: boolean): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setShown(true), INDICATOR_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [active]);
  return active && shown;
}
