/**
 * The clip-in base, and the internal supports.
 *
 * Both are separate closed solids. The base is its own STL, printed flat side
 * down so it needs no support of its own. The supports are emitted alongside
 * the shell in one file: every slicer unions overlapping closed volumes at
 * slice time, so they fuse into the wall without needing a boolean operation —
 * and each body stays individually watertight, which is what the printability
 * check actually tests.
 */
import type { Loop } from './hollow';

// ---------------------------------------------------------------------------
// Polygon helpers
// ---------------------------------------------------------------------------

export interface Point2 {
  x: number;
  z: number;
}

/**
 * Move every point of a ring inward by `distance`.
 *
 * Each point steps along the bisector of its two edges. On a near-convex ring —
 * which a stone's cross-section is — this is accurate and cheap. A sharp
 * reflex corner would over-shoot, so the step is capped.
 */
export function offsetLoop(points: Point2[], distance: number): Point2[] {
  const count = points.length;
  if (count < 3) return points.slice();

  const centroid = points.reduce(
    (total, point) => ({ x: total.x + point.x / count, z: total.z + point.z / count }),
    { x: 0, z: 0 },
  );

  return points.map((point, index) => {
    const previous = points[(index - 1 + count) % count]!;
    const next = points[(index + 1) % count]!;

    // Inward normals of the two adjoining edges, averaged.
    const e1x = point.x - previous.x;
    const e1z = point.z - previous.z;
    const e2x = next.x - point.x;
    const e2z = next.z - point.z;

    const n1 = Math.hypot(e1x, e1z) || 1;
    const n2 = Math.hypot(e2x, e2z) || 1;

    let bx = e1z / n1 + e2z / n2;
    let bz = -e1x / n1 - e2x / n2;
    const length = Math.hypot(bx, bz);

    if (length < 1e-9) {
      // Degenerate corner: fall back to heading for the centroid.
      bx = centroid.x - point.x;
      bz = centroid.z - point.z;
      const fallback = Math.hypot(bx, bz) || 1;
      bx /= fallback;
      bz /= fallback;
    } else {
      bx /= length;
      bz /= length;
    }

    // Point the bisector at the interior, whichever way the ring is wound.
    const towardCentre = (centroid.x - point.x) * bx + (centroid.z - point.z) * bz;
    const sign = towardCentre >= 0 ? 1 : -1;

    return { x: point.x + bx * distance * sign, z: point.z + bz * distance * sign };
  });
}

/** Even sampling around a ring, so two rings can be walked in step. */
export function resampleLoop(points: Point2[], count: number): Point2[] {
  if (points.length < 3) return points.slice();

  const lengths: number[] = [];
  let perimeter = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const segment = Math.hypot(b.x - a.x, b.z - a.z);
    lengths.push(segment);
    perimeter += segment;
  }

  if (perimeter < 1e-9) return points.slice();

  const result: Point2[] = [];
  let target = 0;
  let travelled = 0;
  let index = 0;

  for (let step = 0; step < count; step += 1) {
    target = (step / count) * perimeter;

    while (index < lengths.length - 1 && travelled + lengths[index]! < target) {
      travelled += lengths[index]!;
      index += 1;
    }

    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    const along = lengths[index]! > 1e-9 ? (target - travelled) / lengths[index]! : 0;

    result.push({ x: a.x + (b.x - a.x) * along, z: a.z + (b.z - a.z) * along });
  }

  return result;
}

function signedArea(points: Point2[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    total += a.x * b.z - b.x * a.z;
  }
  return total / 2;
}

/** Fan triangulation from the centroid. Valid for the near-convex rings here. */
function capRing(points: Point2[], y: number, faceUp: boolean, out: number[]): void {
  const count = points.length;
  if (count < 3) return;

  const centroid = points.reduce(
    (total, point) => ({ x: total.x + point.x / count, z: total.z + point.z / count }),
    { x: 0, z: 0 },
  );

  for (let i = 0; i < count; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % count]!;

    if (faceUp) {
      out.push(centroid.x, y, centroid.z, a.x, y, a.z, b.x, y, b.z);
    } else {
      out.push(centroid.x, y, centroid.z, b.x, y, b.z, a.x, y, a.z);
    }
  }
}

/** Vertical wall between two rings at different heights. */
function wallBetween(
  lower: Point2[],
  lowerY: number,
  upper: Point2[],
  upperY: number,
  out: number[],
): void {
  const count = Math.min(lower.length, upper.length);

  for (let i = 0; i < count; i += 1) {
    const a0 = lower[i]!;
    const a1 = lower[(i + 1) % count]!;
    const b0 = upper[i]!;
    const b1 = upper[(i + 1) % count]!;

    out.push(a0.x, lowerY, a0.z, b0.x, upperY, b0.z, a1.x, lowerY, a1.z);
    out.push(a1.x, lowerY, a1.z, b0.x, upperY, b0.z, b1.x, upperY, b1.z);
  }
}

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

export interface BaseSettings {
  /** Gap between plug and cavity wall, per side. Sets how tight the fit is. */
  clearance: number;
  /** How far the plug rises into the cavity. */
  plugDepth: number;
  /** Thickness of the disc that closes the opening. */
  floorThickness: number;
}

export const FIT_PRESETS = [
  { id: 'tight', name: 'Tight', clearance: 0.1, note: 'Firm push fit. May need a trim.' },
  { id: 'normal', name: 'Normal', clearance: 0.2, note: 'Snug. Best starting point.' },
  { id: 'loose', name: 'Loose', clearance: 0.35, note: 'Slides in. Use if tight binds.' },
] as const;

export type FitId = (typeof FIT_PRESETS)[number]['id'];

export interface BaseResult {
  positions: Float32Array;
  triangleCount: number;
  /** Overall footprint, for the print panel. */
  size: { length: number; width: number; height: number };
}

/**
 * Build the plug that closes the opening.
 *
 * Geometry, bottom to top:
 *
 *   - a floor disc matching the stone's outer rim, which becomes the visible
 *     underside of the finished piece
 *   - a plug wall rising into the cavity, inset by the fit clearance
 *   - a lead-in chamfer at the top, so it starts square instead of catching
 *
 * Modelled with its underside at y = 0 so it drops straight onto a build plate.
 * Printed that way the only overhang is the step out to the floor disc, which
 * is a horizontal bridge of one wall thickness and needs no support.
 */
export function buildBase(
  outerLoop: Loop,
  innerLoop: Loop,
  settings: BaseSettings,
): BaseResult {
  const segments = 96;

  const outer = resampleLoop(outerLoop.points, segments);
  const cavity = resampleLoop(innerLoop.points, segments);

  // Both rings must wind the same way or the walls between them fold.
  if (signedArea(outer) < 0) outer.reverse();
  if (signedArea(cavity) < 0) cavity.reverse();

  const plug = offsetLoop(cavity, settings.clearance);
  // A chamfer of half a millimetre is enough to guide the plug in without
  // making the fit sloppy once seated.
  const plugTop = offsetLoop(plug, 0.5);

  const floorTop = settings.floorThickness;
  const plugTopY = floorTop + settings.plugDepth;
  const chamferY = plugTopY - 0.8;

  const triangles: number[] = [];

  // Floor: underside, outer wall, and the shoulder the stone sits on.
  capRing(outer, 0, false, triangles);
  wallBetween(outer, 0, outer, floorTop, triangles);

  // The shoulder is the ring between the stone's footprint and the plug.
  const shoulderSegments = Math.min(outer.length, plug.length);
  for (let i = 0; i < shoulderSegments; i += 1) {
    const a0 = outer[i]!;
    const a1 = outer[(i + 1) % shoulderSegments]!;
    const b0 = plug[i]!;
    const b1 = plug[(i + 1) % shoulderSegments]!;

    triangles.push(a0.x, floorTop, a0.z, a1.x, floorTop, a1.z, b0.x, floorTop, b0.z);
    triangles.push(a1.x, floorTop, a1.z, b1.x, floorTop, b1.z, b0.x, floorTop, b0.z);
  }

  // Plug wall, its lead-in chamfer, and the closing cap.
  wallBetween(plug, floorTop, plug, chamferY, triangles);
  wallBetween(plug, chamferY, plugTop, plugTopY, triangles);
  capRing(plugTop, plugTopY, true, triangles);

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const point of outer) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }

  return {
    positions: new Float32Array(triangles),
    triangleCount: triangles.length / 9,
    size: { length: maxX - minX, width: maxZ - minZ, height: plugTopY },
  };
}

// ---------------------------------------------------------------------------
// Internal supports
// ---------------------------------------------------------------------------

export interface SupportPost {
  id: string;
  /** Position on the cut plane, in millimetres. */
  x: number;
  z: number;
  /** Diameter at the base. */
  diameter: number;
}

export const SUPPORT_DEFAULT_DIAMETER = 6;
export const SUPPORT_MIN_DIAMETER = 2.5;
export const SUPPORT_MAX_DIAMETER = 20;

/**
 * Build a tapered post from the cut plane up to the cavity ceiling.
 *
 * `ceilingFor` returns the inner-surface height above a given point, so a post
 * stops exactly where the cavity does instead of punching through the top. It
 * is the caller's job to supply that by sampling the shell.
 *
 * The post widens slightly at the bottom: a straight column that meets the
 * floor at a sharp corner is where a print most often lets go, and a small
 * fillet costs nothing.
 */
export function buildSupportPost(
  post: SupportPost,
  planeY: number,
  ceilingY: number,
  segments = 20,
): number[] {
  const triangles: number[] = [];

  const height = ceilingY - planeY;
  if (height <= 0.5) return triangles;

  const radius = Math.max(SUPPORT_MIN_DIAMETER, post.diameter) / 2;
  // A flare of a quarter of the radius over the first 15% of the height.
  const flare = radius * 1.25;
  const flareHeight = Math.min(height * 0.15, radius);

  const ringAt = (r: number): Point2[] =>
    Array.from({ length: segments }, (_, i) => {
      const angle = (i / segments) * Math.PI * 2;
      return { x: post.x + Math.cos(angle) * r, z: post.z + Math.sin(angle) * r };
    });

  const foot = ringAt(flare);
  const body = ringAt(radius);
  // Narrowing at the top keeps the contact patch small, so the post snaps off
  // cleanly if it is ever meant to be removed.
  const head = ringAt(radius * 0.72);

  capRing(foot, planeY, false, triangles);
  wallBetween(foot, planeY, body, planeY + flareHeight, triangles);
  wallBetween(body, planeY + flareHeight, head, ceilingY, triangles);
  capRing(head, ceilingY, true, triangles);

  return triangles;
}

/**
 * Height of the cavity ceiling above a point, by casting a vertical ray at the
 * shell's triangles.
 *
 * Done directly on the triangle soup rather than through a scene graph, because
 * this runs on the raw geometry during export where no scene exists.
 */
export function ceilingHeightAt(
  shellPositions: Float32Array,
  x: number,
  z: number,
  fromY: number,
): number | null {
  let best: number | null = null;

  for (let t = 0; t < shellPositions.length; t += 9) {
    const ax = shellPositions[t]!;
    const ay = shellPositions[t + 1]!;
    const az = shellPositions[t + 2]!;
    const bx = shellPositions[t + 3]!;
    const by = shellPositions[t + 4]!;
    const bz = shellPositions[t + 5]!;
    const cx = shellPositions[t + 6]!;
    const cy = shellPositions[t + 7]!;
    const cz = shellPositions[t + 8]!;

    // Barycentric test in plan view; a vertical ray only cares about x and z.
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-12) continue;

    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const w = 1 - u - v;

    if (u < 0 || v < 0 || w < 0) continue;

    const y = u * ay + v * by + w * cy;
    // Only surfaces above the starting height can be a ceiling, and the lowest
    // of those is the one a post would actually meet.
    if (y > fromY + 1 && (best === null || y < best)) best = y;
  }

  return best;
}

/** Is a point inside a ring? Ray casting in plan view. */
export function pointInLoop(points: Point2[], x: number, z: number): boolean {
  let inside = false;

  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i]!;
    const b = points[j]!;

    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }

  return inside;
}
