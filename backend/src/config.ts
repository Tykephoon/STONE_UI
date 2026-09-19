/**
 * Runtime configuration.
 *
 * Every secret the system holds is read here, from the process environment, on
 * the server. Nothing in this file is ever sent to, or derivable from, the
 * frontend bundle. The frontend's only configuration is the public API base URL.
 *
 * There are no session or cookie settings: this installation has no user
 * accounts. The only credential it holds is the upstream map key.
 */
import { z } from 'zod';

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const booleanish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  /** Absolute or relative path to the SQLite file. On Fly.io this lives on the mounted volume. */
  DATABASE_PATH: z.string().default('./data/stone.sqlite'),

  /**
   * Explicit CORS allowlist. Never a wildcard: the API issues credentialed
   * cookies, and `Access-Control-Allow-Origin: *` is invalid with credentials
   * anyway. Set this to exactly the Pages origin in production.
   */
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://127.0.0.1:5173')
    .transform(csv),

  /**
   * Set true only when running behind a proxy that sets X-Forwarded-For
   * (Fly.io does). Rate limiting is keyed by IP, so getting this wrong means
   * every request appears to come from the proxy and shares one bucket.
   */
  TRUST_PROXY: booleanish.default('false'),

  /** Per-device ingest ceiling. A Pico posting every 5s uses 12/min. */
  INGEST_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(120),
  /** Largest accepted batch in a single ingest call. */
  INGEST_MAX_BATCH: z.coerce.number().int().min(1).max(1000).default(200),

  /**
   * Upstream map tile template, e.g.
   *   https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key={key}
   * `{key}` is substituted server-side from MAP_TILES_KEY and never leaves this
   * process. If unset, the proxy falls back to keyless OSM raster tiles.
   */
  MAP_TILES_URL: z.string().url().optional(),
  MAP_TILES_KEY: z.string().optional(),
  MAP_TILES_ATTRIBUTION: z.string().default('© OpenStreetMap contributors'),
  MAP_TILE_SIZE: z.coerce.number().int().min(128).max(1024).default(256),
  MAP_MAX_ZOOM: z.coerce.number().int().min(1).max(24).default(19),

  /**
   * Upstream geocoder. `{q}` and `{key}` are substituted server-side.
   * If unset, the proxy falls back to Nominatim, which requires a descriptive
   * User-Agent under its usage policy.
   */
  GEOCODE_URL: z.string().url().optional(),
  GEOCODE_KEY: z.string().optional(),
  GEO_CONTACT_USER_AGENT: z
    .string()
    .default('stone-telemetry/1.0 (+https://github.com/)'),

  /** Per-user ceilings on the proxy routes, so they cannot be driven as an open relay. */
  GEO_TILE_RATE_PER_MINUTE: z.coerce.number().int().min(1).default(600),
  GEO_SEARCH_RATE_PER_MINUTE: z.coerce.number().int().min(1).default(30),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof envSchema> & {
  isProduction: boolean;
  isTest: boolean;
};

function load(): Config {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Fail fast and loudly at boot rather than half-configured at request time.
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  const env = parsed.data;

  if (env.NODE_ENV === 'production') {
    if (env.ALLOWED_ORIGINS.some((origin) => origin.includes('localhost'))) {
      // Not fatal, but it means a dev origin can drive the production API.
      console.warn('[config] ALLOWED_ORIGINS contains a localhost entry in production.');
    }
    if (!env.TRUST_PROXY) {
      console.warn(
        '[config] TRUST_PROXY is false in production. Behind a proxy this collapses ' +
          'every caller into one rate-limit bucket.',
      );
    }
  }

  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
  };
}

export const config = load();
