import { useEffect, useRef } from 'react';

/**
 * Run a callback on an interval.
 *
 * Pass `null` to pause. The callback is held in a ref so a new closure each
 * render does not restart the timer — otherwise a polling interval would reset
 * on every state update and effectively never fire.
 */
export function useInterval(callback: () => void, delayMs: number | null): void {
  const saved = useRef(callback);
  saved.current = callback;

  useEffect(() => {
    if (delayMs === null) return;
    const timer = setInterval(() => saved.current(), delayMs);
    return () => clearInterval(timer);
  }, [delayMs]);
}
