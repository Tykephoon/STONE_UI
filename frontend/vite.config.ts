import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig, loadEnv } from 'vite';

/**
 * Build-time Content-Security-Policy injection.
 *
 * The policy has to name the API origin in `connect-src`, and that origin is
 * the one piece of genuinely public configuration the bundle carries. Writing
 * it by hand in index.html would mean a policy that silently drifts from the
 * configured backend, so it is derived from the same value the API client uses.
 *
 * A meta tag cannot express `frame-ancestors` or `report-uri` — those are
 * header-only. The equivalent header is documented in SECURITY.md for hosts
 * that can set one; GitHub Pages cannot.
 */
function contentSecurityPolicy(apiBaseUrl: string): Plugin {
  const apiOrigin = (() => {
    try {
      return new URL(apiBaseUrl).origin;
    } catch {
      return '';
    }
  })();

  const policy = [
    "default-src 'self'",
    // No inline or eval'd script. Vite emits external modules in production.
    "script-src 'self'",
    // MapLibre injects style rules at runtime, which requires inline styles.
    // This is style-src, not script-src: it cannot execute code.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Only ourselves and the API. Telemetry cannot be exfiltrated to a third
    // party even if a value somehow reached a DOM sink.
    `connect-src 'self' ${apiOrigin}`.trim(),
    // The 3D generator runs in a module worker created from a blob URL.
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');

  return {
    name: 'stone-csp',
    transformIndexHtml(html) {
      return html.replace('%CSP_POLICY%', policy);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiBaseUrl = env.VITE_API_BASE_URL || 'http://localhost:8080';

  return {
    // Relative asset paths, so the same bundle works at
    // https://user.github.io/repo/ and at the domain root without rebuilding.
    base: './',
    plugins: [react(), contentSecurityPolicy(apiBaseUrl)],
    define: {
      __APP_VERSION__: JSON.stringify(
        (JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }).version,
      ),
    },
    build: {
      target: 'es2022',
      outDir: 'dist',
      sourcemap: false,
      // Source maps are off in production on purpose: they are not a secret
      // leak on their own, but they publish the full original source of a page
      // that handles sessions, for no user benefit.
      rollupOptions: {
        output: {
          manualChunks: {
            // three and maplibre are large and change rarely; splitting them
            // keeps the app chunk small and cacheable across deploys.
            three: ['three'],
            maplibre: ['maplibre-gl'],
            react: ['react', 'react-dom', 'react-router-dom'],
          },
        },
      },
      chunkSizeWarningLimit: 1200,
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    preview: {
      port: 4173,
      strictPort: true,
    },
  };
});
