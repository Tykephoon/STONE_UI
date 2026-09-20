/**
 * 3D-printing export and analysis.
 *
 * STL is the format every slicer accepts, and it is unitless by convention —
 * slicers assume millimetres. The generator already works in millimetres, so
 * the mesh is written out at true size with no scaling: a 220 mm stone arrives
 * in the slicer as 220 mm.
 *
 * The stats matter more than they look. A mesh that is not watertight will
 * either be silently "repaired" by the slicer into something the user did not
 * design, or rejected outright, and finding that out after a failed print is
 * expensive. So the check runs here and the answer is shown before export.
 */
import type { BufferGeometry } from 'three';

export interface PrintStats {
  triangleCount: number;
  /** Cubic millimetres of solid material if printed at 100% infill. */
  volumeMm3: number;
  surfaceAreaMm2: number;
  boundingBox: { length: number; width: number; height: number };
  /**
   * True when every edge is shared by exactly two triangles — the condition a
   * slicer needs to decide what is inside the model.
   */
  isWatertight: boolean;
  /** Edges failing that test. Zero when watertight. */
  openEdgeCount: number;
}

/**
 * Quantise a coordinate before using it as a hash key.
 *
 * Vertices that should be identical can differ in the last float bit after the
 * scaling pass, which would make a perfectly closed mesh look full of holes.
 * A micron is far below any printable resolution and far above that error.
 */
function vertexKey(x: number, y: number, z: number): string {
  const q = (value: number) => Math.round(value * 1000);
  return `${q(x)},${q(y)},${q(z)}`;
}

export function computePrintStats(geometry: BufferGeometry): PrintStats {
  const position = geometry.getAttribute('position');
  const array = position.array as Float32Array;
  const triangleCount = position.count / 3;

  let volume = 0;
  let area = 0;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  // Edge use counts, keyed so that an edge and its reverse collide.
  const edges = new Map<string, number>();

  for (let t = 0; t < triangleCount; t += 1) {
    const o = t * 9;

    const ax = array[o]!;
    const ay = array[o + 1]!;
    const az = array[o + 2]!;
    const bx = array[o + 3]!;
    const by = array[o + 4]!;
    const bz = array[o + 5]!;
    const cx = array[o + 6]!;
    const cy = array[o + 7]!;
    const cz = array[o + 8]!;

    for (const [x, y, z] of [
      [ax, ay, az],
      [bx, by, bz],
      [cx, cy, cz],
    ] as const) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    // Signed volume of the tetrahedron from the origin. Summed over a closed
    // surface this is the enclosed volume, with sign set by winding order.
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;

    // Half the cross-product magnitude is the triangle's area.
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;
    area +=
      Math.hypot(
        e1y * e2z - e1z * e2y,
        e1z * e2x - e1x * e2z,
        e1x * e2y - e1y * e2x,
      ) / 2;

    const keyA = vertexKey(ax, ay, az);
    const keyB = vertexKey(bx, by, bz);
    const keyC = vertexKey(cx, cy, cz);

    for (const [from, to] of [
      [keyA, keyB],
      [keyB, keyC],
      [keyC, keyA],
    ] as const) {
      // Sort the pair so an edge traversed in either direction hashes the same.
      const key = from < to ? `${from}|${to}` : `${to}|${from}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }

  let openEdgeCount = 0;
  for (const count of edges.values()) {
    if (count !== 2) openEdgeCount += 1;
  }

  return {
    triangleCount,
    volumeMm3: Math.abs(volume),
    surfaceAreaMm2: area,
    boundingBox: {
      length: maxX - minX,
      width: maxZ - minZ,
      height: maxY - minY,
    },
    isWatertight: openEdgeCount === 0,
    openEdgeCount,
  };
}

/** Common filament and resin densities, in grams per cubic centimetre. */
export const MATERIALS = [
  { id: 'pla', name: 'PLA', density: 1.24 },
  { id: 'petg', name: 'PETG', density: 1.27 },
  { id: 'abs', name: 'ABS', density: 1.04 },
  { id: 'resin', name: 'Resin', density: 1.1 },
  { id: 'nylon', name: 'Nylon', density: 1.15 },
] as const;

export type MaterialId = (typeof MATERIALS)[number]['id'];

/**
 * Estimated printed mass.
 *
 * Infill is a fraction of the interior; the shell is treated as solid, which is
 * why this is an estimate rather than a figure to quote. A slicer's own
 * calculation is authoritative.
 */
export function estimateMass(volumeMm3: number, density: number, infill: number): number {
  const cubicCentimetres = volumeMm3 / 1000;
  // Roughly: perimeter and top/bottom layers account for ~25% of the volume at
  // typical wall settings, and that portion prints solid regardless of infill.
  const shellFraction = 0.25;
  const effective = shellFraction + (1 - shellFraction) * infill;
  return cubicCentimetres * density * effective;
}

/**
 * Write a binary STL.
 *
 * Binary rather than ASCII: the same mesh is roughly a fifth of the size, and
 * every slicer reads it. Header is 80 bytes, then a triangle count, then 50
 * bytes per facet.
 */
export function buildStl(geometry: BufferGeometry, name: string): ArrayBuffer {
  return buildStlFromPositions(geometry.getAttribute('position').array as Float32Array, name);
}

/**
 * Same writer, over a raw triangle soup.
 *
 * The hollow shell and its supports never become a BufferGeometry — they are
 * built for export, not for display — so they are written straight from their
 * position arrays.
 */
export function buildStlFromPositions(array: Float32Array, name: string): ArrayBuffer {
  const triangleCount = array.length / 9;

  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);

  // The 80-byte header is free-form. Some tools display it, so name the file
  // rather than leaving it zeroed — but never start it with "solid", which
  // makes parsers guess ASCII.
  const header = `Stone generated model: ${name}`.slice(0, 79);
  for (let i = 0; i < header.length; i += 1) {
    view.setUint8(i, header.charCodeAt(i) & 0x7f);
  }

  view.setUint32(80, triangleCount, true);

  let offset = 84;

  for (let t = 0; t < triangleCount; t += 1) {
    const o = t * 9;

    const ax = array[o]!;
    const ay = array[o + 1]!;
    const az = array[o + 2]!;
    const bx = array[o + 3]!;
    const by = array[o + 4]!;
    const bz = array[o + 5]!;
    const cx = array[o + 6]!;
    const cy = array[o + 7]!;
    const cz = array[o + 8]!;

    // STL stores a face normal per facet. Recomputed from the winding rather
    // than taken from the vertex normals, which are smoothed and would be
    // wrong here.
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;

    /*
      Axis convention. The viewer uses Y-up; STL and every slicer use Z-up with
      the build plate at Z=0. Mapping (x, y, z) → (x, -z, y) rotates the model
      upright, so it lands on the plate the same way round it sat on the grid
      rather than on its side.
    */
    const write = (x: number, y: number, z: number) => {
      view.setFloat32(offset, x, true);
      view.setFloat32(offset + 4, -z, true);
      view.setFloat32(offset + 8, y, true);
      offset += 12;
    };

    write(nx, ny, nz);
    write(ax, ay, az);
    write(bx, by, bz);
    write(cx, cy, cz);

    // Attribute byte count: unused, and non-zero values confuse some slicers.
    view.setUint16(offset, 0, true);
    offset += 2;
  }

  return buffer;
}
