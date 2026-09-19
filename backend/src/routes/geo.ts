/**
 * Map tile and geocoding proxy.
 *
 * This exists so that no map credential ever reaches the browser. MapLibre
 * renders against these routes; the upstream key lives in this process's
 * environment and is substituted here.
 *
 * Three properties stop this becoming an open relay:
 *
 *   1. Per-IP rate limits, separate from the global limiter, so one caller
 *      cannot pull tiles on our quota indefinitely.
 *   2. The upstream URL is built from a server-side template with numerically
 *      validated tile coordinates. No part of the caller's input is ever
 *      treated as a URL, so the proxy cannot be pointed at an arbitrary host.
 *   3. Only image and vector-tile content types are forwarded, and geocoder
 *      output is reshaped rather than passed through.
 *
 * With no user accounts these routes are public, so the rate limits are the
 * only thing standing between the deployment and someone else's bandwidth
 * bill. Keep them tight, and prefer a provider key with a hard quota.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { rateLimited, upstreamUnavailable } from '../lib/errors.js';
import { RateLimiter } from '../lib/ratelimit.js';
import { parseOrThrow } from '../lib/validate.js';

const tileLimiter = new RateLimiter(config.GEO_TILE_RATE_PER_MINUTE, 60_000);
const searchLimiter = new RateLimiter(config.GEO_SEARCH_RATE_PER_MINUTE, 60_000);

/** Keyless fallbacks, so the app is usable in development with no provider account. */
const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEFAULT_GEOCODE_URL =
  'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q={q}';

const tileParamsSchema = z
  .object({
    z: z.coerce.number().int().min(0).max(24),
    x: z.coerce.number().int().min(0),
    y: z.coerce.number().int().min(0),
  })
  .strict();

const searchQuerySchema = z
  .object({
    q: z.string().trim().min(2, 'Enter at least two characters.').max(120),
  })
  .strip();

/** Upstream responses are only forwarded if they are actually map data. */
const ALLOWED_TILE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'application/x-protobuf',
  'application/vnd.mapbox-vector-tile',
];

const TILE_TIMEOUT_MS = 8_000;
const SEARCH_TIMEOUT_MS = 6_000;

async function fetchWithTimeout(url: string, timeoutMs: number, headers: Record<string, string>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

export async function geoRoutes(app: FastifyInstance): Promise<void> {
  /**
   * MapLibre style document.
   *
   * Tile URLs point back at this API, and the raster layer is desaturated and
   * dimmed so the basemap sits behind the dark UI rather than glaring through
   * it.
   */
  app.get('/api/geo/style.json', async (request) => {
    const origin = `${request.protocol}://${request.headers.host ?? ''}`;

    return {
      version: 8,
      name: 'Stone Dark',
      sources: {
        basemap: {
          type: 'raster',
          tiles: [`${origin}/api/geo/tiles/{z}/{x}/{y}`],
          tileSize: config.MAP_TILE_SIZE,
          maxzoom: config.MAP_MAX_ZOOM,
          attribution: config.MAP_TILES_ATTRIBUTION,
        },
      },
      layers: [
        {
          id: 'background',
          type: 'background',
          paint: { 'background-color': '#0c0d10' },
        },
        {
          id: 'basemap',
          type: 'raster',
          source: 'basemap',
          paint: {
            'raster-opacity': 0.72,
            'raster-saturation': -0.7,
            'raster-contrast': 0.08,
            'raster-brightness-min': 0.04,
            'raster-brightness-max': 0.82,
          },
        },
      ],
    };
  });

  app.get(
    '/api/geo/tiles/:z/:x/:y',
    { config: { rateLimit: false } },
    async (request, reply) => {
      // Keyed by IP: there is no user to key on.
      const limit = tileLimiter.check(request.ip);
      if (!limit.allowed) {
        reply.header('retry-after', String(limit.retryAfterSeconds));
        throw rateLimited('Map is loading too quickly. Pause a moment.');
      }

      const params = parseOrThrow(tileParamsSchema, request.params);

      if (params.z > config.MAP_MAX_ZOOM) {
        throw rateLimited('Zoom level unavailable.');
      }

      // A z/x/y triple outside the pyramid is always a bug or a probe.
      const max = 2 ** params.z;
      if (params.x >= max || params.y >= max) {
        reply.code(404);
        return { error: { code: 'not_found', message: 'Tile out of range.' } };
      }

      const template = config.MAP_TILES_URL ?? DEFAULT_TILE_URL;
      const url = template
        .replace('{z}', String(params.z))
        .replace('{x}', String(params.x))
        .replace('{y}', String(params.y))
        .replace('{key}', encodeURIComponent(config.MAP_TILES_KEY ?? ''));

      let upstream: Response;
      try {
        upstream = await fetchWithTimeout(url, TILE_TIMEOUT_MS, {
          'user-agent': config.GEO_CONTACT_USER_AGENT,
          accept: ALLOWED_TILE_TYPES.join(','),
        });
      } catch (cause) {
        // The upstream URL and provider error are logged, never returned.
        throw upstreamUnavailable(cause);
      }

      if (!upstream.ok) {
        if (upstream.status === 404) {
          reply.code(404);
          return { error: { code: 'not_found', message: 'Tile not available.' } };
        }
        throw upstreamUnavailable({ status: upstream.status });
      }

      const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!ALLOWED_TILE_TYPES.includes(contentType)) {
        throw upstreamUnavailable({ contentType });
      }

      const body = Buffer.from(await upstream.arrayBuffer());

      reply.header('content-type', contentType);
      // Tiles are immutable for a given z/x/y and identical for every caller,
      // so a shared cache in front of this route is a straight win: fewer
      // requests against the upstream provider's quota.
      reply.header('cache-control', 'public, max-age=86400');
      return reply.send(body);
    },
  );

  /**
   * Place search.
   *
   * Results are reshaped into a small fixed structure rather than forwarded
   * verbatim, so upstream response changes cannot leak provider metadata — or
   * anything resembling a quota identifier — into the client.
   */
  app.get('/api/geo/search', { config: { rateLimit: false } }, async (request, reply) => {
    const limit = searchLimiter.check(request.ip);
    if (!limit.allowed) {
      reply.header('retry-after', String(limit.retryAfterSeconds));
      throw rateLimited('Too many searches. Try again in a moment.');
    }

    const query = parseOrThrow(searchQuerySchema, request.query);

    const template = config.GEOCODE_URL ?? DEFAULT_GEOCODE_URL;
    const url = template
      .replace('{q}', encodeURIComponent(query.q))
      .replace('{key}', encodeURIComponent(config.GEOCODE_KEY ?? ''));

    let upstream: Response;
    try {
      upstream = await fetchWithTimeout(url, SEARCH_TIMEOUT_MS, {
        // Nominatim's usage policy requires an identifying User-Agent.
        'user-agent': config.GEO_CONTACT_USER_AGENT,
        accept: 'application/json',
      });
    } catch (cause) {
      throw upstreamUnavailable(cause);
    }

    if (!upstream.ok) {
      throw upstreamUnavailable({ status: upstream.status });
    }

    let payload: unknown;
    try {
      payload = await upstream.json();
    } catch (cause) {
      throw upstreamUnavailable(cause);
    }

    return { results: normaliseGeocodeResults(payload) };
  });
}

export interface GeoResult {
  label: string;
  latitude: number;
  longitude: number;
  kind: string | null;
}

/**
 * Accepts either a Nominatim array or a GeoJSON FeatureCollection (MapTiler,
 * Mapbox-compatible geocoders), and returns the same shape for both.
 */
export function normaliseGeocodeResults(payload: unknown): GeoResult[] {
  const results: GeoResult[] = [];

  const pushIfValid = (label: unknown, lat: unknown, lon: unknown, kind: unknown) => {
    const latitude = typeof lat === 'string' ? Number.parseFloat(lat) : lat;
    const longitude = typeof lon === 'string' ? Number.parseFloat(lon) : lon;

    if (
      typeof label !== 'string' ||
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return;
    }

    results.push({
      label: label.slice(0, 200),
      latitude,
      longitude,
      kind: typeof kind === 'string' ? kind.slice(0, 60) : null,
    });
  };

  if (Array.isArray(payload)) {
    for (const item of payload.slice(0, 10)) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      pushIfValid(record.display_name ?? record.name, record.lat, record.lon, record.type);
    }
    return results;
  }

  if (payload && typeof payload === 'object' && Array.isArray((payload as { features?: unknown }).features)) {
    const features = (payload as { features: unknown[] }).features.slice(0, 10);
    for (const feature of features) {
      if (!feature || typeof feature !== 'object') continue;
      const record = feature as Record<string, unknown>;
      const geometry = record.geometry as { coordinates?: unknown } | undefined;
      const coordinates = geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) continue;

      const properties = (record.properties ?? {}) as Record<string, unknown>;
      pushIfValid(
        record.place_name ?? properties.label ?? properties.name,
        coordinates[1],
        coordinates[0],
        Array.isArray(record.place_type) ? record.place_type[0] : properties.kind,
      );
    }
  }

  return results;
}
