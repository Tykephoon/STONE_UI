/**
 * Public runtime configuration.
 *
 * Vite inlines `import.meta.env.VITE_*` into the bundle as literal strings, and
 * the bundle is world-readable on GitHub Pages. Only non-sensitive display
 * settings may appear here.
 *
 * There is nothing sensitive to configure: the app has no server, no accounts,
 * and no third-party keys. Maps use OpenStreetMap, which needs none. If a keyed
 * provider is ever adopted, its key must not come back here — it would be
 * published. See SECURITY.md.
 */

export const config = {
  /** Shown in the sidebar footer; purely cosmetic. */
  environmentLabel: import.meta.env.VITE_ENVIRONMENT_LABEL?.trim() || null,

  version: __APP_VERSION__,
} as const;
