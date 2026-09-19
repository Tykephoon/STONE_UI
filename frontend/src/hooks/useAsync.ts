/**
 * Async data loading with the four states every view needs: idle, loading,
 * error, and data.
 *
 * Deliberately small — no cache, no deduplication, no background revalidation.
 * The app's data is either explicitly refreshed or polled on an interval, and a
 * caching layer would add a dependency plus a class of staleness bugs for no
 * benefit here.
 */
import { type DependencyList, useCallback, useEffect, useRef, useState } from 'react';
import { DataError } from '../data/store';

export interface AsyncState<T> {
  data: T | null;
  error: DataError | null;
  /** True only on the first load, so a refresh does not blank the view. */
  isLoading: boolean;
  /** True on every load including background refreshes. */
  isFetching: boolean;
  reload: () => void;
}

export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  options: { enabled?: boolean } = {},
): AsyncState<T> {
  const { enabled = true } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<DataError | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Held in a ref so changing the loader identity between renders does not
  // re-trigger the effect; `deps` is the explicit trigger.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    let active = true;

    setIsFetching(true);

    loaderRef
      .current(controller.signal)
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        // An abort is the caller's own cleanup, not a failure to report.
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(
          cause instanceof DataError
            ? cause
            : new DataError('Something went wrong.'),
        );
      })
      .finally(() => {
        if (!active) return;
        setIsFetching(false);
        setHasLoaded(true);
      });

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled]);

  return {
    data,
    error,
    isLoading: isFetching && !hasLoaded,
    isFetching,
    reload,
  };
}

/**
 * Outcome of a single action run.
 *
 * `run` reports success through its return value rather than leaving the caller
 * to inspect `error` state. That state belongs to the *next* render, so reading
 * it immediately after `await run(...)` sees the previous value — which would
 * make a failed delete look like a successful one.
 */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: DataError };

/**
 * One-shot async action (submit, delete, rotate) with pending and error state.
 */
export function useAction<Args extends unknown[], Result>(
  action: (...args: Args) => Promise<Result>,
): {
  run: (...args: Args) => Promise<ActionResult<Result>>;
  isPending: boolean;
  error: DataError | null;
  reset: () => void;
} {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<DataError | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const actionRef = useRef(action);
  actionRef.current = action;

  const run = useCallback(async (...args: Args): Promise<ActionResult<Result>> => {
    setIsPending(true);
    setError(null);
    try {
      const data = await actionRef.current(...args);
      return { ok: true, data };
    } catch (cause) {
      const normalised =
        cause instanceof DataError
          ? cause
          : new DataError('Something went wrong.');
      if (mounted.current) setError(normalised);
      return { ok: false, error: normalised };
    } finally {
      if (mounted.current) setIsPending(false);
    }
  }, []);

  const reset = useCallback(() => setError(null), []);

  return { run, isPending, error, reset };
}
