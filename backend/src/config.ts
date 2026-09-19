/**
 * Runtime configuration.
 *
 * Every secret the system holds is read here, from the process environment, on
 * the server. Nothing in this file is ever sent to, or derivable from, the
 * frontend bundle. The frontend's only configuration is the public API base URL.
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

  /** Sliding session window. Short by design; the client refreshes silently. */
  SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  /** Hard cap regardless of activity. Re-authentication required after this. */
  SESSION_ABSOLUTE_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(168),

  /**
   * Cookies are `SameSite=None; Secure` because the SPA is served from a
   * different origin (github.io) than the API. Browsers treat `localhost` as a
   * trustworthy origin, so `Secure` cookies are accepted over plain HTTP there
   * and local development needs no override. These knobs exist for unusual
   * hosting setups only.
   */
  COOKIE_SECURE: booleanish.default('true'),
  COOKIE_SAMESITE: z.enum(['none', 'lax', 'strict']).default('none'),
  COOKIE_DOMAIN: z.string().optional(),

  /** Set true only when running behind a proxy that sets X-Forwarded-For (Fly.io does). */
  TRUST_PROXY: booleanish.default('false'),

  /** Allows closing signups once the intended users have accounts. */
  REGISTRATION_ENABLED: booleanish.default('true'),

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
    if (!env.COOKIE_SECURE) {
      throw new Error('COOKIE_SECURE must be true in production.');
    }
  }

  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
  };
}

export const config = load();
