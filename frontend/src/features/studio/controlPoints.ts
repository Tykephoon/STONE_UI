/**
 * Surface control points.
 *
 * A fixed set of directions on the unit sphere, each with a pull value. Pulling
 * one outward raises a bump; pushing it inward presses a dent. Influence falls
 * off with angular distance, so a pull affects a region rather than a single
 * vertex — which is what makes it read as sculpting rather than as poking a
 * hole in a mesh.
 *
 * The directions are fixed and derived, not stored. That matters for three
 * reasons: handles stay in predictable places between edits, a design only has
 * to store one number per point, and a shared link stays short.
 */

/**
 * How many handles sit on the stone.
 *
 * Fourteen is a judgement: enough to shape a rock meaningfully, few enough that
 * the viewport does not turn into a ball of dots. It is also small enough that
 * the whole sculpt encodes in a URL without trouble.
 */
export const CONTROL_POINT_COUNT = 14;

/**
 * Evenly spread directions via a Fibonacci sphere.
 *
 * Even spacing matters: latitude/longitude grids bunch points at the poles, so
 * the top of the stone would be over-controlled and its waist under-controlled.
 */
export function controlPointDirection(index: number): [number, number, number] {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  // Spread y uniformly over (-1, 1); offsetting by a half step keeps points
  // off the exact poles, where the azimuth is undefined.
  const y = 1 - ((index + 0.5) / CONTROL_POINT_COUNT) * 2;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = goldenAngle * index;

  return [Math.cos(theta) * radius, y, Math.sin(theta) * radius];
}

/** All directions, computed once. */
export const CONTROL_POINT_DIRECTIONS: [number, number, number][] = Array.from(
  { length: CONTROL_POINT_COUNT },
  (_, index) => controlPointDirection(index),
);

/** A pull of 1 moves the surface out by this fraction of the base radius. */
export const MAX_PULL_AMPLITUDE = 0.38;

/** Influence 0 → a tight dimple; influence 1 → a broad swell. Radians. */
export function influenceRadians(influence: number): number {
  return 0.28 + influence * 1.05;
}

export interface SculptParams {
  /** One pull per control point, −1 to 1. Zero everywhere means untouched. */
  pulls: number[];
  /** Angular reach of each pull, 0 to 1. */
  influence: number;
}

export function emptySculpt(): SculptParams {
  return {
    pulls: new Array<number>(CONTROL_POINT_COUNT).fill(0),
    influence: 0.45,
  };
}

export function isSculpted(sculpt: SculptParams): boolean {
  return sculpt.pulls.some((pull) => Math.abs(pull) > 0.001);
}

/**
 * Coerce a stored or shared sculpt into a usable one.
 *
 * Length is normalised to the current point count, so a design saved before the
 * count changed still loads — it simply keeps the pulls it has.
 */
export function sanitiseSculpt(input: unknown): SculptParams {
  const fallback = emptySculpt();
  if (!input || typeof input !== 'object') return fallback;

  const raw = input as Partial<SculptParams>;
  const pulls = new Array<number>(CONTROL_POINT_COUNT).fill(0);

  if (Array.isArray(raw.pulls)) {
    for (let index = 0; index < Math.min(raw.pulls.length, CONTROL_POINT_COUNT); index += 1) {
      const value = Number(raw.pulls[index]);
      pulls[index] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    }
  }

  const influence = Number(raw.influence);

  return {
    pulls,
    influence: Number.isFinite(influence) ? Math.max(0, Math.min(1, influence)) : fallback.influence,
  };
}

/**
 * Surface displacement contributed by every control point in a direction.
 *
 * Returned as a fraction of the base radius, to be added by the generator.
 * Contributions sum, so two overlapping pulls build on each other the way a
 * sculptor's thumb would.
 */
export function sculptDisplacement(
  dx: number,
  dy: number,
  dz: number,
  sculpt: SculptParams,
): number {
  const reach = influenceRadians(sculpt.influence);
  const cosReach = Math.cos(reach);
  let total = 0;

  for (let index = 0; index < CONTROL_POINT_COUNT; index += 1) {
    const pull = sculpt.pulls[index];
    if (!pull) continue;

    const direction = CONTROL_POINT_DIRECTIONS[index]!;
    const cosAngle = dx * direction[0] + dy * direction[1] + dz * direction[2];

    // Comparing cosines avoids an acos for every vertex that is out of range,
    // which is most of them at every control point.
    if (cosAngle <= cosReach) continue;

    const angle = Math.acos(Math.min(1, cosAngle));
    const t = 1 - angle / reach;
    // Smoothstep, so the edge of a pull blends into the surface instead of
    // leaving a visible crease.
    const falloff = t * t * (3 - 2 * t);

    total += pull * MAX_PULL_AMPLITUDE * falloff;
  }

  return total;
}
