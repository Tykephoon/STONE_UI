/**
 * Scale and tick maths shared by every chart.
 *
 * Small and dependency-free by design: the app draws six chart shapes, and a
 * general charting library would ship an order of magnitude more code into a
 * page that handles sessions.
 */

export interface LinearScale {
  (value: number): number;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  invert(pixel: number): number;
}

export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  // A zero-width domain (every value identical) would divide by zero; centre
  // the line in the plot instead.
  const span = d1 - d0 || 1;

  const scale = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as {
    (value: number): number;
    domain: readonly [number, number];
    range: readonly [number, number];
    invert(pixel: number): number;
  };

  scale.domain = domain;
  scale.range = range;
  scale.invert = (pixel: number) => d0 + ((pixel - r0) / (r1 - r0 || 1)) * span;

  return scale as LinearScale;
}

/**
 * Round a domain outward to values a reader can hold in their head.
 *
 * Axis labels of 0 / 25 / 50 are worth more than 3.7 / 28.4 / 53.1, so the
 * domain is widened rather than the ticks being placed at raw extremes.
 */
export function niceDomain(
  min: number,
  max: number,
  tickCount = 5,
): { domain: [number, number]; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { domain: [0, 1], ticks: [0, 0.5, 1] };
  }

  if (min === max) {
    // A flat series still needs a readable band around it.
    const padding = Math.abs(min) * 0.1 || 1;
    min -= padding;
    max += padding;
  }

  const rawStep = (max - min) / Math.max(1, tickCount);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;

  // Snap to 1, 2, 5, or 10 times a power of ten.
  let step: number;
  if (normalised <= 1) step = magnitude;
  else if (normalised <= 2) step = 2 * magnitude;
  else if (normalised <= 5) step = 5 * magnitude;
  else step = 10 * magnitude;

  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;

  const ticks: number[] = [];
  // Accumulating with multiplication rather than repeated addition avoids
  // floating-point drift producing ticks like 0.30000000000000004.
  const count = Math.round((niceMax - niceMin) / step);
  for (let index = 0; index <= count; index += 1) {
    ticks.push(Number((niceMin + index * step).toPrecision(12)));
  }

  return { domain: [niceMin, niceMax], ticks };
}

/** Extent of a numeric series, ignoring nulls. */
export function extent(values: (number | null | undefined)[]): [number, number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let seen = false;

  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    seen = true;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  return seen ? [min, max] : null;
}

/**
 * Build an SVG path for a series, breaking the line at gaps.
 *
 * A null reading means the sensor reported nothing. Interpolating across it
 * would draw data that was never collected, so the path lifts the pen and
 * resumes — the gap is the honest rendering.
 */
export function linePath(
  points: { x: number; y: number | null }[],
  xScale: LinearScale,
  yScale: LinearScale,
): string {
  let path = '';
  let penDown = false;

  for (const point of points) {
    if (point.y === null || !Number.isFinite(point.y)) {
      penDown = false;
      continue;
    }
    const x = xScale(point.x).toFixed(2);
    const y = yScale(point.y).toFixed(2);
    path += penDown ? `L${x},${y}` : `M${x},${y}`;
    penDown = true;
  }

  return path;
}

/** Companion area path, closed to the baseline, with the same gap behaviour. */
export function areaPath(
  points: { x: number; y: number | null }[],
  xScale: LinearScale,
  yScale: LinearScale,
  baseline: number,
): string {
  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];

  for (const point of points) {
    if (point.y === null || !Number.isFinite(point.y)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push({ x: point.x, y: point.y });
  }
  if (current.length > 0) segments.push(current);

  const baseY = yScale(baseline).toFixed(2);

  return segments
    .filter((segment) => segment.length > 1)
    .map((segment) => {
      const top = segment
        .map((point, index) => {
          const x = xScale(point.x).toFixed(2);
          const y = yScale(point.y).toFixed(2);
          return `${index === 0 ? 'M' : 'L'}${x},${y}`;
        })
        .join('');
      const firstX = xScale(segment[0]!.x).toFixed(2);
      const lastX = xScale(segment[segment.length - 1]!.x).toFixed(2);
      return `${top}L${lastX},${baseY}L${firstX},${baseY}Z`;
    })
    .join(' ');
}

/** Pick roughly `count` evenly spaced indices from a list, always including the ends. */
export function sampleIndices(length: number, count: number): number[] {
  if (length <= count) return Array.from({ length }, (_, index) => index);

  const indices: number[] = [];
  const step = (length - 1) / (count - 1);
  for (let index = 0; index < count; index += 1) {
    indices.push(Math.round(index * step));
  }
  return [...new Set(indices)];
}

/** Format an axis tick compactly without losing the distinction between ticks. */
export function formatTick(value: number, step: number): string {
  const decimals =
    step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : Math.min(6, Math.ceil(-Math.log10(step)));

  if (Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  }

  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** The eight validated categorical slots, in fixed order. Never cycled. */
export const SERIES_VARS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
] as const;

/**
 * Colour for series slot `index`.
 *
 * Throws past slot 8 rather than wrapping: a ninth series must be folded into
 * "Other" or split into small multiples, because a repeated hue silently makes
 * two different series look like one.
 */
export function seriesColor(index: number): string {
  const color = SERIES_VARS[index];
  if (!color) {
    throw new Error(
      `No categorical slot ${index + 1}: the validated palette has 8. ` +
        'Fold the extra series into "Other" or use small multiples.',
    );
  }
  return color;
}
