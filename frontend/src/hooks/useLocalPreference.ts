import { useCallback, useState } from 'react';

/**
 * A UI preference persisted in localStorage.
 *
 * For display preferences only — sidebar collapsed, preferred units, live-poll
 * on/off. Never for anything derived from a session: tokens and user data stay
 * out of web storage entirely so an injected script has nothing to read.
 */
export function useLocalPreference<T>(key: string, fallback: T): [T, (value: T) => void] {
  const storageKey = `stone.pref.${key}`;

  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === null ? fallback : (JSON.parse(stored) as T);
    } catch {
      // Private-browsing modes and disabled storage both throw here.
      return fallback;
    }
  });

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // A preference that cannot be persisted is not worth failing over.
      }
    },
    [storageKey],
  );

  return [value, update];
}
