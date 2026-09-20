/**
 * Real elevation at a point on Earth.
 *
 * The studio's whole premise is that a stone belongs to a place. Coordinates
 * alone only seeded the noise, which made the stone *repeatable* per location
 * but not *derived* from it — Kansas and the Karakoram produced equally
 * plausible rocks. This module reads the actual ground.
 *
 * The source is the public terrain tile set on S3: a global digital elevation
 * model published as PNG, keyless, with no quota and no account. Each pixel
 * carries a metre value in its colour channels rather than a shade of grey,
 * which is what makes it decodable rather than merely displayable.
 *
 * A word on "real time", since the UI offers current data: the *imagery* is
 * whatever Esri publishes today, and does change. The elevation model does not
 * update minute to minute — no free one does, and ground measured by radar
 * does not move on that timescale anyway. What is accurate is the shape of the
 * land, to roughly thirty metres horizontally.
 *
 * Network and canvas work is confined to `fetchTerrain`. Everything else is
 * arithmetic over a Float32Array, so the parts that decide what a stone looks
 * like are testable without a browser or a network.
 */

/**
 * Terrarium encoding: elevation in metres packed across three channels.
 *
 * The offset exists because the channels are unsigned — the Dead Sea and
 * Everest both have to fit in the same range.
 */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

const EQUATOR_METRES_PER_PIXEL = 156_543.03392;

/** Metres per pixel at a given zoom and latitude, for 256-pixel tiles. */
export function groundResolution(latitude: number, zoom: number): number {
  return (EQUATOR_METRES_PER_PIXEL * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
}

/**
 * Global pixel coordinates in the Web Mercator pyramid.
 *
 * Fractional on purpose: the centre of the requested window is almost never on
 * a pixel boundary, and rounding it there would move the sample by up to
 * thirty metres — a whole DEM cell, for nothing.
 */
export function lngLatToPixel(
  longitude: number,
  latitude: number,
  zoom: number,
): { x: number; y: number } {
  const worldSize = 256 * 2 ** zoom;
  // Mercator is undefined at the poles; clamp to the standard cutoff.
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const sin = Math.sin((clamped * Math.PI) / 180);

  return {
    x: ((longitude + 180) / 360) * worldSize,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize,
  };
}

/**
 * The zoom whose pixels land closest to the sample spacing we want.
 *
 * Asking for finer samples than the model holds buys interpolation, not
 * detail; asking for coarser throws the landform away. The bounds are the tile
 * set's own — below 8 the shape is gone, above 14 most of the world is
 * upsampled from the same measurements.
 */
export function zoomForSpan(latitude: number, spanMeters: number, gridSize: number): number {
  const wanted = spanMeters / gridSize;
  const exact = Math.log2(
    (EQUATOR_METRES_PER_PIXEL * Math.cos((latitude * Math.PI) / 180)) / wanted,
  );
  return Math.max(8, Math.min(14, Math.round(exact)));
}

export interface TerrainSample {
  latitude: number;
  longitude: number;
  /** Width of the sampled square on the ground, in metres. */
  spanMeters: number;
  /** The grid is `size` × `size`. */
  size: number;
  metresPerSample: number;
  /** Row-major, row 0 northernmost, column 0 westernmost. Metres. */
  heights: Float32Array;
  /** Elevation directly under the pin, in metres. */
  centreElevation: number;
}

export interface TerrainSummary {
  minElevation: number;
  maxElevation: number;
  meanElevation: number;
  /** Highest minus lowest across the window, in metres. */
  relief: number;
  /** Mean steepness, in degrees from horizontal. */
  slopeDegrees: number;
  /**
   * How far the ground departs from a smooth surface, 0 to 1.
   *
   * Measured as mean curvature relative to the sample spacing, which tells a
   * broken scree slope from a steep but even hillside. Relief alone cannot:
   * both are tall.
   */
  roughness: number;
  /** Downhill direction, degrees clockwise from north. */
  aspectDegrees: number;
  /** True when the window is flat enough that shape cues mean nothing. */
  flat: boolean;
}

/** Bilinear height lookup. `east` and `north` run −1 to 1 across the window. */
export function heightAt(sample: TerrainSample, east: number, north: number): number {
  const { size, heights } = sample;
  const last = size - 1;

  // North is row 0, so more north means a lower row index.
  const fx = ((east + 1) / 2) * last;
  const fy = ((1 - north) / 2) * last;

  const x0 = Math.max(0, Math.min(last, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(last, Math.floor(fy)));
  const x1 = Math.min(last, x0 + 1);
  const y1 = Math.min(last, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));

  const h00 = heights[y0 * size + x0]!;
  const h10 = heights[y0 * size + x1]!;
  const h01 = heights[y1 * size + x0]!;
  const h11 = heights[y1 * size + x1]!;

  return h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty;
}

export function summariseTerrain(sample: TerrainSample): TerrainSummary {
  const { heights, size, metresPerSample } = sample;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let total = 0;

  for (const height of heights) {
    if (height < min) min = height;
    if (height > max) max = height;
    total += height;
  }

  const mean = total / heights.length;
  const relief = max - min;

  // Gradients and curvature over the interior, where a full neighbourhood
  // exists. One-sided differences at the edge read as extra roughness in a
  // ring all the way round the window.
  let slopeTotal = 0;
  let curvatureTotal = 0;
  let eastFall = 0;
  let northFall = 0;
  let count = 0;

  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const here = heights[y * size + x]!;
      const west = heights[y * size + x - 1]!;
      const east = heights[y * size + x + 1]!;
      const north = heights[(y - 1) * size + x]!;
      const south = heights[(y + 1) * size + x]!;

      const dzdx = (east - west) / (2 * metresPerSample);
      // Row index grows southward, so this difference is already northward.
      const dzdy = (south - north) / (2 * metresPerSample);

      slopeTotal += Math.sqrt(dzdx * dzdx + dzdy * dzdy);
      curvatureTotal += Math.abs(east + west + north + south - 4 * here);

      eastFall -= dzdx;
      northFall -= dzdy;
      count += 1;
    }
  }

  const meanSlope = count > 0 ? slopeTotal / count : 0;
  const meanCurvature = count > 0 ? curvatureTotal / count : 0;

  // Curvature is metres of departure across one sample spacing. Dividing by
  // that spacing makes it dimensionless, so the number means the same thing
  // whether the window is two kilometres across or two hundred metres.
  const roughness = Math.max(0, Math.min(1, meanCurvature / metresPerSample / 0.6));

  // A metre of relief across a kilometre is measurement noise, not a landform.
  const flat = relief < Math.max(2, sample.spanMeters * 0.002);

  let aspect = (Math.atan2(eastFall, northFall) * 180) / Math.PI;
  if (aspect < 0) aspect += 360;

  return {
    minElevation: min,
    maxElevation: max,
    meanElevation: mean,
    relief,
    slopeDegrees: (Math.atan(meanSlope) * 180) / Math.PI,
    roughness,
    aspectDegrees: flat ? 0 : aspect,
    flat,
  };
}

/** Host and template kept beside the code that justifies them. See SECURITY.md. */
export const TERRAIN_TILE_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export class TerrainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerrainError';
  }
}

/** Default window: wide enough to hold a hill, tight enough to be one place. */
export const DEFAULT_SPAN_METERS = 1800;
const GRID_SIZE = 96;

function tileUrl(z: number, x: number, y: number): string {
  return TERRAIN_TILE_URL.replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/**
 * Read a square of ground around a coordinate.
 *
 * The window nearly always straddles tile boundaries, so every tile it touches
 * is fetched, drawn into one canvas at its true offset, and read back as a
 * single image. Stitching after the fact would mean handling each seam twice
 * and getting the fractional offset right both times.
 */
export async function fetchTerrain(
  latitude: number,
  longitude: number,
  options: { spanMeters?: number; signal?: AbortSignal } = {},
): Promise<TerrainSample> {
  const spanMeters = options.spanMeters ?? DEFAULT_SPAN_METERS;
  const zoom = zoomForSpan(latitude, spanMeters, GRID_SIZE);
  const resolution = groundResolution(latitude, zoom);

  const centre = lngLatToPixel(longitude, latitude, zoom);
  const halfPixels = spanMeters / 2 / resolution;

  const left = centre.x - halfPixels;
  const top = centre.y - halfPixels;
  const width = halfPixels * 2;

  const tileX0 = Math.floor(left / 256);
  const tileY0 = Math.floor(top / 256);
  const tileX1 = Math.floor((left + width) / 256);
  const tileY1 = Math.floor((top + width) / 256);

  const tilesAcross = 2 ** zoom;
  // The window can cross the antimeridian, where tile x runs off the end of
  // the pyramid and continues from the other side.
  const wrapX = (value: number): number => ((value % tilesAcross) + tilesAcross) % tilesAcross;

  const canvasWidth = (tileX1 - tileX0 + 1) * 256;
  const canvasHeight = (tileY1 - tileY0 + 1) * 256;

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new TerrainError('This browser cannot read elevation data.');

  const loads: Promise<void>[] = [];

  for (let ty = tileY0; ty <= tileY1; ty += 1) {
    // Past the pole there is no tile. Leaving the gap at zero is right: there
    // is no ground there to describe.
    if (ty < 0 || ty >= tilesAcross) continue;

    for (let tx = tileX0; tx <= tileX1; tx += 1) {
      const url = tileUrl(zoom, wrapX(tx), ty);
      const offsetX = (tx - tileX0) * 256;
      const offsetY = (ty - tileY0) * 256;

      loads.push(
        (async () => {
          const response = await fetch(url, options.signal ? { signal: options.signal } : {});
          if (!response.ok) throw new TerrainError('Elevation data is unavailable right now.');

          const bitmap = await createImageBitmap(await response.blob());
          context.drawImage(bitmap, offsetX, offsetY);
          bitmap.close();
        })(),
      );
    }
  }

  try {
    await Promise.all(loads);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    if (cause instanceof TerrainError) throw cause;
    throw new TerrainError('Elevation data could not be reached.');
  }

  let pixels: Uint8ClampedArray;
  try {
    pixels = context.getImageData(0, 0, canvasWidth, canvasHeight).data;
  } catch {
    // A tainted canvas means a tile arrived without CORS headers. Report what
    // that means for the user rather than what threw.
    throw new TerrainError('Elevation data could not be read from this source.');
  }

  const heights = new Float32Array(GRID_SIZE * GRID_SIZE);
  const step = width / (GRID_SIZE - 1);
  const originX = left - tileX0 * 256;
  const originY = top - tileY0 * 256;

  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let column = 0; column < GRID_SIZE; column += 1) {
      const px = Math.max(0, Math.min(canvasWidth - 1, Math.round(originX + column * step)));
      const py = Math.max(0, Math.min(canvasHeight - 1, Math.round(originY + row * step)));
      const index = (py * canvasWidth + px) * 4;

      heights[row * GRID_SIZE + column] = decodeTerrarium(
        pixels[index]!,
        pixels[index + 1]!,
        pixels[index + 2]!,
      );
    }
  }

  const sample: TerrainSample = {
    latitude,
    longitude,
    spanMeters,
    size: GRID_SIZE,
    metresPerSample: spanMeters / (GRID_SIZE - 1),
    heights,
    centreElevation: 0,
  };

  sample.centreElevation = heightAt(sample, 0, 0);
  return sample;
}
