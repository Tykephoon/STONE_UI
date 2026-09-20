/**
 * Maps, place search, and ground imagery, with no server in between.
 *
 * With the backend gone there is no proxy, so the browser talks to each
 * provider directly. That is only acceptable because **every source here is
 * keyless** — there is no credential to leak, which was the entire reason the
 * proxy existed. If this app ever adopts a keyed provider (Mapbox, Google,
 * MapTiler), the key must not come back here: it would be published in the
 * bundle for anyone to lift. Route it through the optional backend's
 * `/api/geo/*` instead.
 *
 * Google Earth was asked for and is deliberately absent. Its tiles need a
 * browser key, which in a static site is a published key, and its terms forbid
 * deriving a dataset from the imagery — which is exactly what the studio does
 * with it. The stack below is the keyless equivalent: Esri's aerial imagery for
 * the picture, an open elevation model for the relief, and MapLibre's terrain
 * renderer to put the two together into something you can tilt and fly.
 *
 * Every source carries a usage policy rather than a quota, and this module is
 * written to stay inside them:
 *
 *   - Tiles and imagery: attribution is required, and is rendered by the map
 *     control. Volume is modest — a personal studio, not a tile-heavy product.
 *   - Nominatim: at most one request per second, from a real user action. The
 *     throttle below enforces that rather than trusting the UI to.
 */
import type { GeoResult } from './types';
import { TERRAIN_TILE_URL } from './terrain';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

export const ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>';

const ESRI_ATTRIBUTION =
  '<a href="https://www.esri.com/" target="_blank" rel="noreferrer">Imagery © Esri</a>, Maxar, Earthstar Geographics';

const TERRAIN_ATTRIBUTION =
  '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noreferrer">Elevation: Tilezen, NASA, USGS</a>';

/** Aerial imagery. Note the `{y}/{x}` order — Esri's service is not `{x}/{y}`. */
const IMAGERY_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

const STREET_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export type BasemapId = 'satellite' | 'streets';

export interface Basemap {
  id: BasemapId;
  name: string;
  /** One line explaining what this view is good for. */
  note: string;
}

export const BASEMAPS: Basemap[] = [
  { id: 'satellite', name: 'Satellite', note: 'Aerial imagery. What the ground actually looks like.' },
  { id: 'streets', name: 'Map', note: 'Names, roads, and boundaries. Easier to navigate by.' },
];

export interface MapStyleOptions {
  basemap?: BasemapId;
  /** Adds the elevation model, so the map can be tilted into real relief. */
  terrain?: boolean;
}

/**
 * MapLibre style document, built here rather than fetched.
 *
 * Fetching a style would mean a third party could change what this app renders
 * — and, with the CSP written from a single host list, would be one more
 * origin to admit. Building it locally keeps both under control.
 *
 * The street layer is desaturated and dimmed so the basemap sits behind the
 * dark interface rather than glaring through it. Imagery is left alone: the
 * point of looking at a place is seeing its real colour.
 */
export function buildMapStyle(options: MapStyleOptions = {}): Record<string, unknown> {
  const basemap = options.basemap ?? 'streets';
  const satellite = basemap === 'satellite';

  const sources: Record<string, unknown> = {
    basemap: {
      type: 'raster',
      tiles: [satellite ? IMAGERY_TILE_URL : STREET_TILE_URL],
      tileSize: 256,
      maxzoom: satellite ? 19 : 19,
      attribution: satellite ? ESRI_ATTRIBUTION : ATTRIBUTION,
    },
  };

  const layers: Record<string, unknown>[] = [
    { id: 'background', type: 'background', paint: { 'background-color': '#0c0d10' } },
    {
      id: 'basemap',
      type: 'raster',
      source: 'basemap',
      paint: satellite
        ? { 'raster-opacity': 1, 'raster-saturation': -0.12, 'raster-contrast': 0.06 }
        : {
            'raster-opacity': 0.72,
            'raster-saturation': -0.7,
            'raster-contrast': 0.08,
            'raster-brightness-min': 0.04,
            'raster-brightness-max': 0.82,
          },
    },
  ];

  if (options.terrain) {
    const dem = {
      type: 'raster-dem',
      tiles: [TERRAIN_TILE_URL],
      tileSize: 256,
      // The tile set is global to 14 and patchy above it. Asking for more
      // returns upsampled copies of the same measurements.
      maxzoom: 14,
      encoding: 'terrarium',
      attribution: TERRAIN_ATTRIBUTION,
    };

    // Two sources over the same tiles, on MapLibre's own advice: terrain and
    // hillshade want the data at different resolutions, and sharing one source
    // makes each degrade the other's cache. The tiles are fetched once and
    // served from the HTTP cache to the second source.
    sources['terrain-dem'] = dem;
    sources['hillshade-dem'] = { ...dem };

    // Shading from the same elevation model. On the street basemap this is
    // most of what makes relief legible; over imagery it deepens shadow that
    // the photograph already has, so it is kept faint.
    layers.push({
      id: 'hillshade',
      type: 'hillshade',
      source: 'hillshade-dem',
      paint: {
        'hillshade-exaggeration': satellite ? 0.18 : 0.45,
        'hillshade-shadow-color': '#05070a',
        'hillshade-highlight-color': satellite ? '#ffffff' : '#8fa0bb',
      },
    });
  }

  const style: Record<string, unknown> = {
    version: 8,
    name: satellite ? 'Stone Satellite' : 'Stone Dark',
    sources,
    layers,
  };

  if (options.terrain) {
    // Slight exaggeration. True scale reads as flat at the zooms people
    // actually browse at, because a hill is wide and the eye is close.
    style['terrain'] = { source: 'terrain-dem', exaggeration: 1.35 };
    style['sky'] = {
      'sky-color': '#0d1420',
      'horizon-color': '#243043',
      'fog-color': '#0c0d10',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.7,
    };
  }

  return style;
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
 *
 * Type-ahead makes this load-bearing rather than precautionary: debouncing in
 * the component limits how often a search *starts*, but only this limits how
 * often one reaches the network.
 */
let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();
const MIN_INTERVAL_MS = 1100;

function throttle<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const next = queue.then(async () => {
    const wait = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

    // Typing on has already made this query obsolete. Dropping it here rather
    // than in the caller means the spent slot goes to the query that matters.
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

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
  }, signal);
}

export interface GroundColour {
  /** Average ground colour at the pin, pulled toward what stone does. */
  color: string;
  /** A darker companion, for the crevices. */
  accentColor: string;
}

const IMAGERY_SAMPLE_ZOOM = 16;
/** Pixels either side of the pin to average. About 150 m at zoom 16. */
const IMAGERY_SAMPLE_RADIUS = 48;

function toHex(r: number, g: number, b: number): string {
  const channel = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Pull a colour toward the range real stone occupies.
 *
 * Averaged aerial imagery is often vivid — forest canopy is emphatically
 * green, farmland can be near-fluorescent. Taken literally it produces a
 * lime-green rock, which is not what the place looks like on the ground; the
 * canopy is what sits on top of it. Keeping the hue and lightness while
 * cutting the saturation gives a stone that reads as *from* somewhere without
 * pretending to be a leaf.
 */
export function temperToStone(r: number, g: number, b: number, keep = 0.42): [number, number, number] {
  // Rec. 709 luma: the perceptual grey a colour would be.
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [
    luma + (r - luma) * keep,
    luma + (g - luma) * keep,
    luma + (b - luma) * keep,
  ];
}

/**
 * Average the aerial imagery around a point.
 *
 * Best-effort by design: if the tile will not load, or the canvas comes back
 * tainted because a CDN dropped its CORS header, the caller keeps the colours
 * the user already had. A missing colour is a much smaller loss than a failed
 * generate.
 */
export async function sampleGroundColour(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<GroundColour | null> {
  const worldSize = 256 * 2 ** IMAGERY_SAMPLE_ZOOM;
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const sin = Math.sin((clamped * Math.PI) / 180);

  const px = ((longitude + 180) / 360) * worldSize;
  const py = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize;

  const tileX = Math.floor(px / 256);
  const tileY = Math.floor(py / 256);
  const withinX = Math.floor(px - tileX * 256);
  const withinY = Math.floor(py - tileY * 256);

  const url = IMAGERY_TILE_URL.replace('{z}', String(IMAGERY_SAMPLE_ZOOM))
    .replace('{y}', String(tileY))
    .replace('{x}', String(tileX));

  try {
    const response = await fetch(url, signal ? { signal } : {});
    if (!response.ok) return null;

    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;

    context.drawImage(bitmap, 0, 0);
    bitmap.close();

    const left = Math.max(0, withinX - IMAGERY_SAMPLE_RADIUS);
    const top = Math.max(0, withinY - IMAGERY_SAMPLE_RADIUS);
    const width = Math.min(canvas.width - left, IMAGERY_SAMPLE_RADIUS * 2);
    const height = Math.min(canvas.height - top, IMAGERY_SAMPLE_RADIUS * 2);
    if (width <= 0 || height <= 0) return null;

    const { data } = context.getImageData(left, top, width, height);

    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    let darkest = Number.POSITIVE_INFINITY;
    let darkR = 0;
    let darkG = 0;
    let darkB = 0;

    for (let index = 0; index < data.length; index += 4) {
      const pr = data[index]!;
      const pg = data[index + 1]!;
      const pb = data[index + 2]!;

      r += pr;
      g += pg;
      b += pb;
      count += 1;

      const luma = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
      if (luma < darkest) {
        darkest = luma;
        darkR = pr;
        darkG = pg;
        darkB = pb;
      }
    }

    if (count === 0) return null;

    const [mr, mg, mb] = temperToStone(r / count, g / count, b / count);
    // The accent sits in the crevices, so it comes from the shadowed end of
    // the same patch — but blended back toward the average, because the single
    // darkest pixel in an aerial photograph is usually a shadow, not a colour.
    const [ar, ag, ab] = temperToStone(
      (darkR + r / count) / 2,
      (darkG + g / count) / 2,
      (darkB + b / count) / 2,
      0.36,
    );

    return {
      color: toHex(mr, mg, mb),
      accentColor: toHex(ar * 0.62, ag * 0.62, ab * 0.62),
    };
  } catch {
    return null;
  }
}
