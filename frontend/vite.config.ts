import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

/**
 * Hosts the app is allowed to talk to.
 *
 * Four, every one of them keyless. Everything else — telemetry, designs, the
 * 3D generator, the whole hollowing and printing pipeline — runs in the
 * browser against local storage.
 *
 *   - `tile.openstreetmap.org`      street basemap
 *   - `nominatim.openstreetmap.org` place search
 *   - `server.arcgisonline.com`     Esri World Imagery, the aerial view
 *   - `s3.amazonaws.com`            the public elevation model, read both as
 *                                   map terrain and as the data a stone is
 *                                   derived from
 *
 * The last two are what stands in for Google Earth. Google's tiles need a
 * browser key, and a browser key in a static bundle is a published key — see
 * SECURITY.md, and `src/data/geo.ts` for the rest of the reasoning.
 *
 * Adding an entry here means adding a party that can see traffic from this
 * page. Do not widen it casually, and never add a host that needs a key.
 */
const EXTERNAL_HOSTS = [
  'https://tile.openstreetmap.org',
  'https://nominatim.openstreetmap.org',
  'https://server.arcgisonline.com',
  'https://s3.amazonaws.com',
];

/**
 * Build-time Content-Security-Policy injection.
 *
 * Kept in the build rather than written by hand in index.html so the allowed
 * hosts are declared once, beside the code that justifies them.
 *
 * A meta tag cannot express `frame-ancestors` or `report-uri` — those are
 * header-only. The equivalent header is documented in SECURITY.md for hosts
 * that can set one; GitHub Pages cannot.
 */
function contentSecurityPolicy(): Plugin {
  const external = EXTERNAL_HOSTS.join(' ');

  const policy = [
    "default-src 'self'",
    // No inline or eval'd script. Vite emits external modules in production.
    "script-src 'self'",
    // MapLibre injects style rules at runtime. This is style-src, not
    // script-src: it cannot execute code.
    "style-src 'self' 'unsafe-inline'",
    // Raster map tiles arrive as images; blob: covers canvas and worker output.
    `img-src 'self' data: blob: ${external}`,
    "font-src 'self' data:",
    // An uploaded photo or clip is decoded from a blob URL. Video is not
    // covered by img-src, and without this it falls back to default-src and
    // is blocked. No remote media host is listed: nothing is ever uploaded.
    "media-src 'self' blob:",
    // Tiles, imagery, elevation, and the geocoder. Elevation and imagery are
    // fetched rather than merely displayed: both are decoded on a canvas, so
    // they need connect-src and not only img-src.
    `connect-src 'self' ${external}`,
    // The 3D generator and MapLibre both run module workers from blob URLs.
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

export default defineConfig({
  // Relative asset paths, so the same bundle works at
  // https://user.github.io/repo/ and at the domain root without rebuilding.
  base: './',
  plugins: [react(), contentSecurityPolicy()],
  define: {
    __APP_VERSION__: JSON.stringify(
      (JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }).version,
    ),
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // Source maps are off in production deliberately: they are not a secret
    // leak here, but they publish the full original source for no user benefit.
    sourcemap: false,
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
});
