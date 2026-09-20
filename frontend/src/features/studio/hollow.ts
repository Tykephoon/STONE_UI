/**
 * Hollowing: turning the solid stone into a printable vessel with a base.
 *
 * The result is two parts:
 *
 *   - a **shell** — the rock with its underside removed and an inner surface
 *     offset inward by the wall thickness, leaving a cavity and an opening
 *   - a **base** — a separate plug that press-fits the opening and closes it
 *
 * Correctness matters more than elegance here: a mesh that is not watertight
 * either gets silently "repaired" by the slicer into something nobody designed,
 * or is rejected after the model has already been sliced. Every operation below
 * is chosen for whether it can be relied on to close, not for how clever it is.
 *
 * No CSG library. The shell is built by clipping triangles against one plane
 * and stitching the resulting boundary, which is a bounded, well-understood
 * problem. Supports are emitted as separate closed volumes in the same file —
 * every slicer unions overlapping closed bodies at slice time, so a genuine
 * boolean is not needed to get the right solid.
 */

export interface HollowSettings {
  /** Wall thickness in millimetres. */
  wallThickness: number;
  /**
   * Height of the cut above the lowest point of the stone, in millimetres.
   * Everything below this is removed to form the opening.
   */
  openingHeight: number;
}

export interface Loop {
  /** Ordered points around the boundary, on the cut plane. */
  points: { x: number; z: number }[];
}

export interface HollowResult {
  positions: Float32Array;
  triangleCount: number;
  /** Boundary of the outer surface at the cut, ordered. */
  outerLoop: Loop;
  /** Boundary of the inner surface at the cut, ordered. */
  innerLoop: Loop;
  /** Interior volume available for contents, in cubic millimetres. */
  cavityVolumeMm3: number;
  /** Height of the cut, after clamping. Supports start here. */
  cutPlaneY: number;
  /**
   * Vertices whose requested wall would have punched through the far side, and
   * which were pulled back. A non-zero count means the wall is thicker than the
   * shape can carry somewhere.
   */
  pinchedVertices: number;
  /**
   * False when the shape cannot be hollowed at this wall thickness — the stone
   * is too small, or the wall too thick, for a cavity to exist. The returned
   * mesh is then the untouched solid, so the output is always printable even
   * when the request is not satisfiable.
   */
  feasible: boolean;
}

/** Smallest wall a 0.4 mm nozzle can lay down reliably: three perimeters. */
export const MIN_WALL_MM = 1.2;
export const MAX_WALL_MM = 8;

/**
 * Tolerance for treating two points as one, in millimetres.
 *
 * One micron, matching the printability check. The two must agree: if the
 * shell is welded more finely than it is verified, two points a fraction of a
 * micron apart count as distinct here and as one there, and a mesh that is
 * genuinely closed gets reported as leaking.
 */
const WELD = 1e-3;

const key = (x: number, z: number) =>
  `${Math.round(x / WELD)},${Math.round(z / WELD)}`;

// ---------------------------------------------------------------------------
// Inner surface
// ---------------------------------------------------------------------------

/**
 * Average the face normals meeting at each welded position.
 *
 * The rendering normals cannot be used for offsetting: once faceting is on they
 * are per-face, so two coincident vertices carry different normals, offset to
 * different places, and tear the cavity wall open along every shared edge.
 * Welding by position guarantees one offset direction per physical point.
 */
function weldedNormals(positions: Float32Array): Float32Array {
  const accumulated = new Map<string, { x: number; y: number; z: number }>();
  const weld = 1e-4;
  const at = (x: number, y: number, z: number) =>
    `${Math.round(x / weld)},${Math.round(y / weld)},${Math.round(z / weld)}`;

  for (let t = 0; t < positions.length; t += 9) {
    const ax = positions[t]!;
    const ay = positions[t + 1]!;
    const az = positions[t + 2]!;
    const bx = positions[t + 3]!;
    const by = positions[t + 4]!;
    const bz = positions[t + 5]!;
    const cx = positions[t + 6]!;
    const cy = positions[t + 7]!;
    const cz = positions[t + 8]!;

    // Unnormalised, so larger triangles carry proportionally more weight.
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

    for (const [x, y, z] of [
      [ax, ay, az],
      [bx, by, bz],
      [cx, cy, cz],
    ] as const) {
      const k = at(x, y, z);
      const entry = accumulated.get(k);
      if (entry) {
        entry.x += nx;
        entry.y += ny;
        entry.z += nz;
      } else {
        accumulated.set(k, { x: nx, y: ny, z: nz });
      }
    }
  }

  const result = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const entry = accumulated.get(at(positions[i]!, positions[i + 1]!, positions[i + 2]!));
    if (!entry) continue;
    const length = Math.hypot(entry.x, entry.y, entry.z) || 1;
    result[i] = entry.x / length;
    result[i + 1] = entry.y / length;
    result[i + 2] = entry.z / length;
  }

  return result;
}

/**
 * Offset every vertex inward along its normal to make the cavity wall.
 *
 * Along the normal rather than toward the centroid: a radial offset gives a
 * wall whose true thickness falls away wherever the surface is steep, which is
 * precisely where a print is most likely to split.
 *
 * Where the shape is thinner than twice the wall, the offset would cross the
 * far side and invert the solid. Those vertices are pulled back to a safe
 * fraction of their radius and counted, so the UI can say the wall is too
 * thick rather than quietly producing a broken model.
 */
function buildInnerVertices(
  positions: Float32Array,
  normals: Float32Array,
  thickness: number,
  centre: { x: number; y: number; z: number },
): { inner: Float32Array; pinched: number } {
  const inner = new Float32Array(positions.length);
  let pinched = 0;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;

    const ox = x - centre.x;
    const oy = y - centre.y;
    const oz = z - centre.z;
    const radius = Math.hypot(ox, oy, oz);

    let ix = x - normals[i]! * thickness;
    let iy = y - normals[i + 1]! * thickness;
    let iz = z - normals[i + 2]! * thickness;

    const innerRadius = Math.hypot(ix - centre.x, iy - centre.y, iz - centre.z);

    // Crossing the centre, or landing further out than it started, both mean
    // the offset has folded through the solid.
    if (innerRadius >= radius || innerRadius < radius * 0.12) {
      pinched += 1;
      const safe = radius * 0.55;
      const scale = radius > 1e-9 ? safe / radius : 0;
      ix = centre.x + ox * scale;
      iy = centre.y + oy * scale;
      iz = centre.z + oz * scale;
    }

    inner[i] = ix;
    inner[i + 1] = iy;
    inner[i + 2] = iz;
  }

  return { inner, pinched };
}

// ---------------------------------------------------------------------------
// Plane clipping
// ---------------------------------------------------------------------------

interface ClipOutput {
  triangles: number[];
  /** Segments lying on the cut plane, as flat x,z,x,z quadruples. */
  cutEdges: number[];
}

/**
 * Keep the part of each triangle above `planeY`, splitting those that straddle.
 *
 * A triangle crossing the plane becomes one or two triangles, and contributes
 * exactly one segment to the boundary. Collecting those segments is what makes
 * the rim stitchable afterwards.
 */
function clipAbovePlane(source: Float32Array, planeY: number, flip: boolean): ClipOutput {
  const triangles: number[] = [];
  const cutEdges: number[] = [];

  const push = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ) => {
    // Drop slivers: a triangle thinner than a micron carries no surface and
    // only contributes edges that confuse a manifold check.
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.hypot(nx, ny, nz) / 2 < WELD * WELD) return;

    if (flip) {
      // The cavity faces inward, so its winding is reversed against the outside.
      triangles.push(ax, ay, az, cx, cy, cz, bx, by, bz);
    } else {
      triangles.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    }
  };

  for (let t = 0; t < source.length; t += 9) {
    const px = [source[t]!, source[t + 3]!, source[t + 6]!];
    const py = [source[t + 1]!, source[t + 4]!, source[t + 7]!];
    const pz = [source[t + 2]!, source[t + 5]!, source[t + 8]!];

    /*
      Three-way classification, not two.

      A vertex within a micron of the plane is treated as lying *on* it and is
      used unchanged. Interpolating such an edge would produce a cut point a
      fraction of a micron from an existing vertex — distinct enough to be its
      own node, close enough that a slicer welds them — which is exactly how a
      closed shell comes to be reported as leaking.
    */
    const side = py.map((y) => (y > planeY + WELD ? 1 : y < planeY - WELD ? -1 : 0));

    if (side[0]! < 0 && side[1]! < 0 && side[2]! < 0) continue;
    if (side[0]! <= 0 && side[1]! <= 0 && side[2]! <= 0) continue;

    // Sutherland–Hodgman against the single half-space.
    const out: { x: number; y: number; z: number }[] = [];

    for (let i = 0; i < 3; i += 1) {
      const j = (i + 1) % 3;

      if (side[i]! >= 0) {
        out.push({ x: px[i]!, y: side[i]! === 0 ? planeY : py[i]!, z: pz[i]! });
      }

      // Only a genuine crossing needs a new point.
      if ((side[i]! > 0 && side[j]! < 0) || (side[i]! < 0 && side[j]! > 0)) {
        const ratio = (planeY - py[i]!) / (py[j]! - py[i]!);
        out.push({
          x: px[i]! + (px[j]! - px[i]!) * ratio,
          y: planeY,
          z: pz[i]! + (pz[j]! - pz[i]!) * ratio,
        });
      }
    }

    if (out.length < 3) continue;

    // Fan-triangulate the clipped polygon; it is convex by construction.
    for (let i = 1; i < out.length - 1; i += 1) {
      const a = out[0]!;
      const b = out[i]!;
      const c = out[i + 1]!;
      push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }

    // The boundary segment is between the two output points on the plane.
    const onPlane = out.filter((point) => Math.abs(point.y - planeY) <= WELD);
    if (onPlane.length === 2) {
      const [first, second] = onPlane as [typeof out[0], typeof out[0]];
      if (Math.hypot(first.x - second.x, first.z - second.z) > WELD) {
        cutEdges.push(first.x, first.z, second.x, second.z);
      }
    }
  }

  return { triangles, cutEdges };
}

// ---------------------------------------------------------------------------
// Boundary stitching
// ---------------------------------------------------------------------------

/**
 * Chain unordered cut segments into ordered rings.
 *
 * Segments arrive in whatever order the triangles happened to be visited, so
 * they are indexed by welded endpoint and walked.
 *
 * Every ring is returned, not just the largest. A cut that produces more than
 * one ring means the cross-section is in pieces — an outcrop dipping below the
 * plane, or a wall so thick the cavity has broken apart — and stitching only
 * the biggest would leave the rest of the boundary open. The caller uses the
 * count to decide the shape cannot be hollowed at these settings.
 */
interface LoopSet {
  rings: Loop[];
  /**
   * True when every boundary point joins exactly two segments.
   *
   * A point joining three or more is a T-junction: the cut has grazed a vertex
   * where several triangles meet, and the boundary is no longer a set of simple
   * closed curves. Walking it leaves segments unclaimed, and every unclaimed
   * segment is a hole in the finished shell.
   */
  clean: boolean;
}

function buildLoops(cutEdges: number[]): LoopSet {
  const adjacency = new Map<string, { x: number; z: number }[]>();
  const positionOf = new Map<string, { x: number; z: number }>();

  for (let i = 0; i < cutEdges.length; i += 4) {
    const a = { x: cutEdges[i]!, z: cutEdges[i + 1]! };
    const b = { x: cutEdges[i + 2]!, z: cutEdges[i + 3]! };

    const ka = key(a.x, a.z);
    const kb = key(b.x, b.z);
    if (ka === kb) continue;

    positionOf.set(ka, a);
    positionOf.set(kb, b);

    (adjacency.get(ka) ?? adjacency.set(ka, []).get(ka)!).push(b);
    (adjacency.get(kb) ?? adjacency.set(kb, []).get(kb)!).push(a);
  }

  const visited = new Set<string>();
  const rings: Loop[] = [];

  for (const startKey of adjacency.keys()) {
    if (visited.has(startKey)) continue;

    const ring: { x: number; z: number }[] = [];
    let currentKey = startKey;
    let previousKey: string | null = null;

    // Walk until the ring closes or the chain runs out.
    for (let guard = 0; guard < adjacency.size + 2; guard += 1) {
      if (visited.has(currentKey)) break;
      visited.add(currentKey);

      const point = positionOf.get(currentKey);
      if (!point) break;
      ring.push(point);

      const neighbours = adjacency.get(currentKey) ?? [];
      let nextKey: string | null = null;
      for (const neighbour of neighbours) {
        const candidate = key(neighbour.x, neighbour.z);
        if (candidate !== previousKey && !visited.has(candidate)) {
          nextKey = candidate;
          break;
        }
      }

      if (!nextKey) break;
      previousKey = currentKey;
      currentKey = nextKey;
    }

    /*
      Collapse only points the adjacency map already treats as the same node.
      An earlier version deduped by distance, which merged two genuinely
      distinct boundary points and silently dropped the edge between them —
      leaving exactly that many holes in the finished shell.
    */
    const deduped: { x: number; z: number }[] = [];
    for (const point of ring) {
      const last = deduped[deduped.length - 1];
      if (!last || key(last.x, last.z) !== key(point.x, point.z)) deduped.push(point);
    }
    if (
      deduped.length > 1 &&
      key(deduped[0]!.x, deduped[0]!.z) ===
        key(deduped[deduped.length - 1]!.x, deduped[deduped.length - 1]!.z)
    ) {
      deduped.pop();
    }

    if (deduped.length >= 3) rings.push({ points: deduped });
  }

  // Largest first, so the caller can reason about the principal opening.
  rings.sort((left, right) => right.points.length - left.points.length);

  let clean = true;
  for (const neighbours of adjacency.values()) {
    // Duplicate segments between the same pair are harmless; distinct ones
    // beyond two are not.
    const distinct = new Set(neighbours.map((point) => key(point.x, point.z)));
    if (distinct.size !== 2) {
      clean = false;
      break;
    }
  }

  return { rings, clean };
}

/** Signed area, used to force a consistent winding on both rims. */
function signedArea(points: { x: number; z: number }[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    total += a.x * b.z - b.x * a.z;
  }
  return total / 2;
}

/**
 * Close the gap between the outer and inner boundaries with a flat annulus.
 *
 * Every vertex of both rings must be used exactly once, and no new points may
 * be invented. The rim's edges are the same edges the clipped surfaces end on,
 * so anything else leaves the shell open — sampling the rings at fractional
 * positions, for instance, silently skips boundary edges and was the original
 * cause of a leaking shell.
 *
 * The two rings have different point counts, so the walk advances whichever is
 * further behind in normalised position. That consumes both completely and
 * keeps the triangles well shaped.
 */
function stitchRim(outer: Loop, inner: Loop, planeY: number, out: number[]): void {
  const a = outer.points;
  const b = inner.points;
  if (a.length < 3 || b.length < 3) return;

  /*
    Start the inner ring at the point nearest the outer ring's first vertex.
    Without this the annulus is built with a twist in it wherever the two rings
    happen to have started at opposite sides of the stone.
  */
  let offset = 0;
  let nearest = Number.POSITIVE_INFINITY;
  for (let j = 0; j < b.length; j += 1) {
    const distance = (b[j]!.x - a[0]!.x) ** 2 + (b[j]!.z - a[0]!.z) ** 2;
    if (distance < nearest) {
      nearest = distance;
      offset = j;
    }
  }

  const bAt = (index: number) => b[(index + offset) % b.length]!;

  let i = 0;
  let j = 0;

  while (i < a.length || j < b.length) {
    const a0 = a[i % a.length]!;
    const b0 = bAt(j % b.length);

    // Advance whichever ring has made less progress, so both finish together.
    const advanceOuter =
      j >= b.length || (i < a.length && (i + 1) / a.length <= (j + 1) / b.length);

    if (advanceOuter) {
      const a1 = a[(i + 1) % a.length]!;
      // Wound to face down: this is the underside of the vessel.
      out.push(a0.x, planeY, a0.z, b0.x, planeY, b0.z, a1.x, planeY, a1.z);
      i += 1;
    } else {
      const b1 = bAt((j + 1) % b.length);
      out.push(a0.x, planeY, a0.z, b0.x, planeY, b0.z, b1.x, planeY, b1.z);
      j += 1;
    }
  }
}

/** Area of a ring, for reporting the cavity size. */
function ringArea(loop: Loop): number {
  return Math.abs(signedArea(loop.points));
}

/**
 * Is this triangle soup a closed surface?
 *
 * The same test a slicer applies: every edge must be shared by exactly two
 * triangles. Run on the finished shell before it is returned, so no cut height
 * can ever hand back an open mesh — whatever geometry it met on the way.
 *
 * This is a backstop, not a substitute for the checks above. Those explain
 * *why* a shape cannot be hollowed; this one guarantees that an unexplained
 * failure is still caught.
 */
function isClosed(positions: Float32Array): boolean {
  const counts = new Map<string, number>();
  const at = (x: number, y: number, z: number) =>
    `${Math.round(x / WELD)},${Math.round(y / WELD)},${Math.round(z / WELD)}`;

  for (let t = 0; t < positions.length; t += 9) {
    const keys = [
      at(positions[t]!, positions[t + 1]!, positions[t + 2]!),
      at(positions[t + 3]!, positions[t + 4]!, positions[t + 5]!),
      at(positions[t + 6]!, positions[t + 7]!, positions[t + 8]!),
    ];

    for (let e = 0; e < 3; e += 1) {
      const from = keys[e]!;
      const to = keys[(e + 1) % 3]!;
      if (from === to) continue;
      const edge = from < to ? `${from}|${to}` : `${to}|${from}`;
      counts.set(edge, (counts.get(edge) ?? 0) + 1);
    }
  }

  for (const count of counts.values()) {
    if (count !== 2) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the hollow shell.
 *
 * `positions` is the solid mesh as the generator produced it, in millimetres,
 * y-up, resting with its lowest point at y = 0.
 *
 * Rendering normals are deliberately not taken: offsetting needs one direction
 * per welded position, which is computed here.
 */
export function buildHollowShell(
  positions: Float32Array,
  settings: HollowSettings,
): HollowResult {
  const thickness = Math.min(MAX_WALL_MM, Math.max(MIN_WALL_MM, settings.wallThickness));

  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;

  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    sumX += positions[i]!;
    sumY += y;
    sumZ += positions[i + 2]!;
  }

  const vertexCount = positions.length / 3;
  const centre = { x: sumX / vertexCount, y: sumY / vertexCount, z: sumZ / vertexCount };

  /*
    The cut has to land inside the cavity, not below it.

    The cavity floor sits roughly one wall thickness above the outside of the
    stone, so cutting lower passes through solid material: no inner ring forms,
    there is nothing to stitch the rim to, and the shell ends up open. Above the
    mid-line the stone stops being a vessel at all.
  */
  const floorOfCavity = minY + thickness * 1.6;
  const highestUseful = minY + (maxY - minY) * 0.6;

  const planeY = Math.min(
    highestUseful,
    Math.max(floorOfCavity, minY + settings.openingHeight),
  );

  const offsetNormals = weldedNormals(positions);
  const { inner, pinched } = buildInnerVertices(positions, offsetNormals, thickness, centre);

  const outerClip = clipAbovePlane(positions, planeY, false);
  const innerClip = clipAbovePlane(inner, planeY, true);

  const outerSet = buildLoops(outerClip.cutEdges);
  const innerSet = buildLoops(innerClip.cutEdges);

  const outerLoop = outerSet.rings[0] ?? { points: [] };
  const innerLoop = innerSet.rings[0] ?? { points: [] };

  /*
    Refuse rather than approximate, in three cases:

      - no inner ring, so the wall has consumed the whole cross-section
      - more than one ring on either surface, so the cut is in pieces and any
        ring left unstitched would leave the shell open
      - a T-junction on either boundary, where the plane grazed a shared vertex
        and the boundary stopped being a set of simple closed curves
      - a large share of vertices pinched, meaning the wall does not fit the
        shape and the cavity has folded through itself

    Each returns the untouched solid, which is always printable. Shipping an
    open shell that a slicer silently "repairs" would be far worse than saying
    the settings do not work.
  */
  const pinchRatio = pinched / (positions.length / 3);

  if (
    outerLoop.points.length < 3 ||
    innerLoop.points.length < 3 ||
    outerSet.rings.length > 1 ||
    innerSet.rings.length > 1 ||
    !outerSet.clean ||
    !innerSet.clean ||
    pinchRatio > 0.02
  ) {
    return {
      positions,
      triangleCount: positions.length / 9,
      outerLoop: { points: [] },
      innerLoop: { points: [] },
      cavityVolumeMm3: 0,
      cutPlaneY: planeY,
      pinchedVertices: pinched,
      feasible: false,
    };
  }

  // Both rims must run the same way round or the annulus between them folds.
  if (signedArea(outerLoop.points) < 0) outerLoop.points.reverse();
  if (signedArea(innerLoop.points) < 0) innerLoop.points.reverse();

  const triangles: number[] = [...outerClip.triangles, ...innerClip.triangles];
  stitchRim(outerLoop, innerLoop, planeY, triangles);

  const shellPositions = new Float32Array(triangles);

  /*
    Final backstop. If the shell did not close for a reason none of the checks
    above anticipated, fall back to the solid rather than exporting something a
    slicer will silently reinterpret.
  */
  if (!isClosed(shellPositions)) {
    return {
      positions,
      triangleCount: positions.length / 9,
      outerLoop: { points: [] },
      innerLoop: { points: [] },
      cavityVolumeMm3: 0,
      cutPlaneY: planeY,
      pinchedVertices: pinched,
      feasible: false,
    };
  }

  // Rough prism estimate; enough to tell someone whether a keepsake will fit.
  const cavityHeight = Math.max(0, maxY - thickness - planeY);
  const cavityVolume = ringArea(innerLoop) * cavityHeight * 0.62;

  return {
    positions: shellPositions,
    triangleCount: triangles.length / 9,
    outerLoop,
    innerLoop,
    cavityVolumeMm3: Math.max(0, cavityVolume),
    cutPlaneY: planeY,
    pinchedVertices: pinched,
    feasible: true,
  };
}
