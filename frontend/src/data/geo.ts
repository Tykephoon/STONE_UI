/**
 * Maps and place search, with no server in between.
 *
 * With the backend gone there is no proxy, so the browser talks to
 * OpenStreetMap directly. That is only acceptable because **both services are
 * keyless** — there is no credential to leak, which was the entire reason the
 * proxy existed. If this app ever adopts a keyed provider (MapTiler, Mapbox),
 * the key must not come back here: it would be published in the bundle. Route
 * it through the optional backend's `/api/geo/*` instead.
 *
 * Both endpoints carry usage policies rather than quotas, and this module is
 * written to stay inside them:
 *
 *   - Tiles: attribution is required and is rendered by the map control.
 *     Volume is modest — a personal dashboard, not a tile-heavy product.
 *   - Nominatim: at most one request per second, from a real user action.
 *     The throttle below enforces that rather than trusting the UI to.
 */
import type { GeoResult } from './types';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

export const ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>';

/**
 * MapLibre style document, built here instead of fetched.
 *
 * The raster layer is desaturated and dimmed so the basemap sits behind the
 * dark interface rather than glaring through it.
 */
export function buildMapStyle(): Record<string, unknown> {
  return {
    version: 8,
    name: 'Stone Dark',
    sources: {
      basemap: {
        type: 'raster',
        tiles: [TILE_URL],
        tileSize: 256,
        maxzoom: 19,
        attribution: ATTRIBUTION,
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
}

export class GeoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeoError';
  }
}

/**
 * Nominatim's policy is one request per second. This serialises calls and
 * spaces them, so a fast typist queues rather than floods.
 */
let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();
const MIN_INTERVAL_MS = 1100;

function throttle<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(async () => {
    const wait = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return run();
  });

  // Keep the chain alive even when one call rejects.
  queue = next.catch(() => undefined);
  return next;
}

interface NominatimResult {
  display_name?: string;
  name?: string;
  lat?: string;
  lon?: string;
  type?: string;
}

/**
 * Reshape upstream results into a fixed structure rather than passing them
 * through, so a provider change cannot alter what the UI renders.
 */
function normalise(payload: unknown): GeoResult[] {
  if (!Array.isArray(payload)) return [];

  const results: GeoResult[] = [];

  for (const entry of payload.slice(0, 10)) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as NominatimResult;

    const label = item.display_name ?? item.name;
    const latitude = Number.parseFloat(item.lat ?? '');
    const longitude = Number.parseFloat(item.lon ?? '');

    if (
      typeof label !== 'string' ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      continue;
    }

    results.push({
      label: label.slice(0, 200),
      latitude,
      longitude,
      kind: typeof item.type === 'string' ? item.type.slice(0, 60) : null,
    });
  }

  return results;
}

export async function searchPlaces(
  query: string,
  signal?: AbortSignal,
): Promise<{ results: GeoResult[] }> {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    throw new GeoError('Enter at least two characters.');
  }

  return throttle(async () => {
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '8');
    url.searchParams.set('q', trimmed);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json' },
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      throw new GeoError('Place search is unavailable right now.');
    }

    if (!response.ok) {
      throw new GeoError(
        response.status === 429
          ? 'Too many searches. Wait a moment and try again.'
          : 'Place search is unavailable right now.',
      );
    }

    try {
      return { results: normalise(await response.json()) };
    } catch {
      throw new GeoError('Place search returned something unreadable.');
    }
  });
}
