/**
 * Public runtime configuration.
 *
 * Vite inlines `import.meta.env.VITE_*` into the bundle as literal strings, and
 * the bundle is world-readable on GitHub Pages. Only the API base URL and
 * non-sensitive feature flags may appear here.
 *
 * There is no credential in this file and there is no code path in this
 * application that reads one. Anything requiring a key is proxied by the
 * backend — see `src/api/geo.ts`.
 */

function readApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configured) {
    // Trailing slashes make every template literal below ambiguous.
    return configured.replace(/\/+$/, '');
  }

  if (import.meta.env.DEV) {
    return 'http://localhost:8080';
  }

  // Failing loudly at boot beats every request silently hitting the Pages
  // origin and 404-ing with an HTML body.
  throw new Error(
    'VITE_API_BASE_URL is not set. The production build needs the API origin ' +
      'at build time; see frontend/.env.example.',
  );
}

export const config = {
  apiBaseUrl: readApiBaseUrl(),

  /** Shown in the sidebar footer; purely cosmetic. */
  environmentLabel: import.meta.env.VITE_ENVIRONMENT_LABEL?.trim() || null,

  version: __APP_VERSION__,

  /** How often the dashboard re-polls while "live" is on. */
  livePollIntervalMs: 15_000,

  /**
   * Silent session refresh cadence. Comfortably inside the backend's 30-minute
   * sliding window so a rotation never races an in-flight request.
   */
  sessionRefreshIntervalMs: 12 * 60_000,
} as const;
