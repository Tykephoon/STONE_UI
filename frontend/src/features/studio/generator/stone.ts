/**
 * Procedural stone generation.
 *
 * Deliberately free of any three.js import so it can run inside a plain module
 * worker without pulling the renderer into that chunk. The output is raw typed
 * arrays; the main thread wraps them in a BufferGeometry.
 *
 * The pipeline, in order:
 *
 *   1. Subdivided icosahedron → an evenly tessellated unit sphere. Evenness
 *      matters: a UV sphere would crowd vertices at the poles and the
 *      displacement would visibly pinch there.
 *   2. Displace each vertex along its direction by a radius function built from
 *      layered noise, asymmetry, bulge, and erosion.
 *   3. Optionally intersect with a seeded convex polytope, which produces real
 *      flat faces rather than the banding a naive radius quantisation gives.
 *   4. Taper and flatten in object space.
 *   5. Rescale so the bounding box is exactly the requested dimensions.
 *   6. Compute normals — smooth, then blended toward face normals by the
 *      faceting amount — and per-vertex colours for mineral speckle and
 *      crevice shading.
 */
import { Noise3D, clamp, hashSeed, makeRandom, mix, smoothstep } from './noise';

export interface StoneDimensions {
  length_mm: number;
  width_mm: number;
  height_mm: number;
}

export interface StoneForm {
  roundness: number;
  taper: number;
  asymmetry: number;
  flatten: number;
  bulge: number;
}

export interface StoneSurface {
  detail: number;
  grain: number;
  erosion: number;
  faceting: number;
  resolution: number;
}

export interface StoneMaterial {
  color: string;
  accentColor: string;
  roughness: number;
  metalness: number;
  speckle: number;
  clearcoat: number;
}

export interface StoneParams {
  seed: string;
  dimensions: StoneDimensions;
  form: StoneForm;
  surface: StoneSurface;
  material: StoneMaterial;
}

export interface StoneMesh {
  /** Non-indexed triangle soup: 9 floats per triangle. */
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  triangleCount: number;
  /** Realised bounding box in millimetres, for display. */
  bounds: { length: number; width: number; height: number };
}

/** Highest subdivision the UI offers. Level 6 is ~82k triangles. */
export const MAX_RESOLUTION = 6;

// ---------------------------------------------------------------------------
// Icosphere
// ---------------------------------------------------------------------------

interface SphereMesh {
  /** Unit-length vertex directions, xyz triples. */
  vertices: Float32Array;
  /** Triangle vertex indices. */
  indices: Uint32Array;
}

function buildIcosphere(subdivisions: number): SphereMesh {
  const t = (1 + Math.sqrt(5)) / 2;

  let positions: number[] = [
    -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0,
    0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t,
    t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1,
  ];

  let faces: number[] = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];

  // Normalise the twelve base vertices onto the unit sphere.
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    const length = Math.hypot(x, y, z);
    positions[i] = x / length;
    positions[i + 1] = y / length;
    positions[i + 2] = z / length;
  }

  for (let level = 0; level < subdivisions; level += 1) {
    const nextFaces: number[] = [];
    // Cache keyed by the edge's two endpoint indices, so the two triangles
    // sharing an edge reuse one midpoint and the mesh stays watertight.
    const midpointCache = new Map<number, number>();

    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * 1_000_000 + b : b * 1_000_000 + a;
      const cached = midpointCache.get(key);
      if (cached !== undefined) return cached;

      const ax = positions[a * 3]!;
      const ay = positions[a * 3 + 1]!;
      const az = positions[a * 3 + 2]!;
      const bx = positions[b * 3]!;
      const by = positions[b * 3 + 1]!;
      const bz = positions[b * 3 + 2]!;

      let mx = (ax + bx) / 2;
      let my = (ay + by) / 2;
      let mz = (az + bz) / 2;
      const length = Math.hypot(mx, my, mz) || 1;
      mx /= length;
      my /= length;
      mz /= length;

      const index = positions.length / 3;
      positions.push(mx, my, mz);
      midpointCache.set(key, index);
      return index;
    };

    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f]!;
      const b = faces[f + 1]!;
      const c = faces[f + 2]!;

      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);

      nextFaces.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }

    faces = nextFaces;
  }

  return {
    vertices: new Float32Array(positions),
    indices: new Uint32Array(faces),
  };
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

interface FacetPlane {
  nx: number;
  ny: number;
  nz: number;
  d: number;
}

/**
 * Seeded half-spaces whose intersection is a convex polytope.
 *
 * Intersecting the noisy blob with this is what produces believable fracture
 * faces. Quantising the radius instead gives concentric terraces, which reads
 * as a machining artefact rather than as broken rock.
 */
function buildFacetPlanes(random: () => number, count: number): FacetPlane[] {
  const planes: FacetPlane[] = [];

  for (let i = 0; i < count; i += 1) {
    // Uniform directions on the sphere; a naive angle pair clusters at poles.
    const z = random() * 2 - 1;
    const angle = random() * Math.PI * 2;
    const radial = Math.sqrt(Math.max(0, 1 - z * z));

    planes.push({
      nx: radial * Math.cos(angle),
      ny: z,
      nz: radial * Math.sin(angle),
      // Distances near 1 keep the cuts shallow, so facets read as chipped
      // surfaces rather than turning the stone into a gemstone.
      d: 0.78 + random() * 0.26,
    });
  }

  return planes;
}

function polytopeRadius(
  dx: number,
  dy: number,
  dz: number,
  planes: FacetPlane[],
): number {
  let smallest = Number.POSITIVE_INFINITY;

  for (const plane of planes) {
    const dot = dx * plane.nx + dy * plane.ny + dz * plane.nz;
    // Planes facing away from this direction do not bound it.
    if (dot <= 1e-4) continue;
    const distance = plane.d / dot;
    if (distance < smallest) smallest = distance;
  }

  return Number.isFinite(smallest) ? smallest : 1;
}

/**
 * Radius of the stone surface along a unit direction.
 *
 * Amplitudes here were tuned by eye against photographs of river cobbles and
 * fractured granite; the comments record what each term is imitating.
 */
function radiusAt(
  dx: number,
  dy: number,
  dz: number,
  params: StoneParams,
  noise: Noise3D,
  detailNoise: Noise3D,
  planes: FacetPlane[],
  offsets: { ax: number; ay: number; az: number; bias: [number, number, number] },
): number {
  const { form, surface } = params;

  // Rounder stones get less low-frequency deformation. A perfectly round
  // setting still keeps a little, because a perfectly smooth sphere reads as
  // a ball bearing, not a pebble.
  const lumpAmplitude = mix(0.3, 0.06, form.roundness);
  const lump = noise.fbm(dx * 1.15 + offsets.ax, dy * 1.15 + offsets.ay, dz * 1.15 + offsets.az, 3);

  let radius = 1 + lump * lumpAmplitude;

  // Asymmetry: push mass toward one seeded side, modulated so it is not a
  // clean linear gradient.
  if (form.asymmetry > 0) {
    const along = dx * offsets.bias[0] + dy * offsets.bias[1] + dz * offsets.bias[2];
    const modulation = 0.55 + 0.45 * noise.fbm(dx * 0.8, dy * 0.8, dz * 0.8, 2);
    radius += form.asymmetry * 0.26 * along * modulation;
  }

  // Bulge: widen away from the vertical axis, the way a stone settles.
  radius += form.bulge * 0.2 * (1 - dy * dy);

  // Erosion: water wear rounds exposed surfaces and cuts channels. The
  // underside is worn hardest, so the stone gains a flattened base.
  if (surface.erosion > 0) {
    const channels = detailNoise.ridged(dx * 2.6, dy * 2.6, dz * 2.6, 3);
    radius -= surface.erosion * 0.06 * channels;
    const underside = smoothstep(0.1, -0.85, dy);
    radius *= 1 - surface.erosion * 0.14 * underside;
  }

  // Fracture faces.
  if (surface.faceting > 0) {
    const faceted = polytopeRadius(dx, dy, dz, planes);
    radius = mix(radius, Math.min(radius, faceted), surface.faceting);
  }

  // Mid-scale pitting and fine grain. Erosion damps both — a worn stone has
  // lost its sharp texture.
  const wear = 1 - surface.erosion * 0.55;
  radius += surface.detail * 0.055 * wear * detailNoise.fbm(dx * 3.6, dy * 3.6, dz * 3.6, 4);
  radius += surface.grain * 0.022 * wear * detailNoise.fbm(dx * 11, dy * 11, dz * 11, 3);

  // A stone cannot have a negative radius no matter how the sliders are set.
  return Math.max(0.2, radius);
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const int = Number.parseInt(value, 16);
  if (!Number.isFinite(int)) return [0.5, 0.5, 0.5];
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

/** sRGB → linear. Three.js works in linear space; skipping this washes colours out. */
const toLinear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function generateStone(params: StoneParams): StoneMesh {
  const seedValue = hashSeed(params.seed);
  const random = makeRandom(seedValue);
  const noise = new Noise3D(seedValue);
  // A second, independently seeded field so detail is not correlated with the
  // large-scale shape — correlated octaves produce a distinctly synthetic look.
  const detailNoise = new Noise3D(seedValue ^ 0x9e3779b9);

  const offsets = {
    ax: random() * 100,
    ay: random() * 100,
    az: random() * 100,
    bias: (() => {
      const z = random() * 2 - 1;
      const angle = random() * Math.PI * 2;
      const radial = Math.sqrt(Math.max(0, 1 - z * z));
      return [radial * Math.cos(angle), z, radial * Math.sin(angle)] as [number, number, number];
    })(),
  };

  const planes = buildFacetPlanes(random, 9 + Math.floor(random() * 6));

  const resolution = Math.max(2, Math.min(MAX_RESOLUTION, Math.round(params.surface.resolution)));
  const sphere = buildIcosphere(resolution);

  const vertexCount = sphere.vertices.length / 3;
  const displaced = new Float32Array(vertexCount * 3);
  const radii = new Float32Array(vertexCount);

  let minRadius = Number.POSITIVE_INFINITY;
  let maxRadius = Number.NEGATIVE_INFINITY;

  const { taper, flatten } = params.form;

  for (let i = 0; i < vertexCount; i += 1) {
    const dx = sphere.vertices[i * 3]!;
    const dy = sphere.vertices[i * 3 + 1]!;
    const dz = sphere.vertices[i * 3 + 2]!;

    const radius = radiusAt(dx, dy, dz, params, noise, detailNoise, planes, offsets);
    radii[i] = radius;
    if (radius < minRadius) minRadius = radius;
    if (radius > maxRadius) maxRadius = radius;

    let x = dx * radius;
    let y = dy * radius;
    let z = dz * radius;

    // Taper: narrow one end. Clamped so a full-negative taper cannot invert
    // the mesh into itself.
    const taperFactor = clamp(1 + taper * 0.55 * y, 0.25, 1.9);
    x *= taperFactor;
    z *= taperFactor;

    // Flatten toward a slab.
    y *= 1 - flatten * 0.62;

    displaced[i * 3] = x;
    displaced[i * 3 + 1] = y;
    displaced[i * 3 + 2] = z;
  }

  // ---- normalise to the requested bounding box ----------------------------
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < vertexCount; i += 1) {
    const x = displaced[i * 3]!;
    const y = displaced[i * 3 + 1]!;
    const z = displaced[i * 3 + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  const centreZ = (minZ + maxZ) / 2;

  /*
    Non-uniform scale so the realised bounding box equals the requested
    dimensions exactly. The user asked for a specific size; deriving the size
    from the noise and reporting whatever came out would make the dimension
    fields decorative.

    Axis mapping: X = length, Y = height, Z = width.
  */
  const scaleX = params.dimensions.length_mm / (maxX - minX || 1);
  const scaleY = params.dimensions.height_mm / (maxY - minY || 1);
  const scaleZ = params.dimensions.width_mm / (maxZ - minZ || 1);

  // ---- expand to a non-indexed soup with normals and colours --------------
  const triangleCount = sphere.indices.length / 3;
  const positions = new Float32Array(triangleCount * 9);
  const normals = new Float32Array(triangleCount * 9);
  const colors = new Float32Array(triangleCount * 9);

  // Smooth normals are accumulated per shared vertex first, then blended
  // toward the face normal by the faceting amount.
  const smoothNormals = new Float32Array(vertexCount * 3);

  const scaled = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i += 1) {
    scaled[i * 3] = (displaced[i * 3]! - centreX) * scaleX;
    scaled[i * 3 + 1] = (displaced[i * 3 + 1]! - centreY) * scaleY;
    scaled[i * 3 + 2] = (displaced[i * 3 + 2]! - centreZ) * scaleZ;
  }

  for (let f = 0; f < triangleCount; f += 1) {
    const ia = sphere.indices[f * 3]!;
    const ib = sphere.indices[f * 3 + 1]!;
    const ic = sphere.indices[f * 3 + 2]!;

    const ax = scaled[ia * 3]!;
    const ay = scaled[ia * 3 + 1]!;
    const az = scaled[ia * 3 + 2]!;
    const bx = scaled[ib * 3]!;
    const by = scaled[ib * 3 + 1]!;
    const bz = scaled[ib * 3 + 2]!;
    const cx = scaled[ic * 3]!;
    const cy = scaled[ic * 3 + 1]!;
    const cz = scaled[ic * 3 + 2]!;

    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;

    // Unnormalised cross product: its length is proportional to triangle area,
    // which is exactly the weighting smooth normals should use.
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    for (const index of [ia, ib, ic]) {
      smoothNormals[index * 3] = smoothNormals[index * 3]! + nx;
      smoothNormals[index * 3 + 1] = smoothNormals[index * 3 + 1]! + ny;
      smoothNormals[index * 3 + 2] = smoothNormals[index * 3 + 2]! + nz;
    }
  }

  // Normalise the accumulated smooth normals.
  for (let i = 0; i < vertexCount; i += 1) {
    const nx = smoothNormals[i * 3]!;
    const ny = smoothNormals[i * 3 + 1]!;
    const nz = smoothNormals[i * 3 + 2]!;
    const length = Math.hypot(nx, ny, nz) || 1;
    smoothNormals[i * 3] = nx / length;
    smoothNormals[i * 3 + 1] = ny / length;
    smoothNormals[i * 3 + 2] = nz / length;
  }

  const base = hexToRgb(params.material.color).map(toLinear) as [number, number, number];
  const accent = hexToRgb(params.material.accentColor).map(toLinear) as [number, number, number];
  const radiusSpan = maxRadius - minRadius || 1;
  const faceting = params.surface.faceting;
  const speckle = params.material.speckle;

  for (let f = 0; f < triangleCount; f += 1) {
    const indices = [
      sphere.indices[f * 3]!,
      sphere.indices[f * 3 + 1]!,
      sphere.indices[f * 3 + 2]!,
    ];

    const ax = scaled[indices[0]! * 3]!;
    const ay = scaled[indices[0]! * 3 + 1]!;
    const az = scaled[indices[0]! * 3 + 2]!;
    const bx = scaled[indices[1]! * 3]!;
    const by = scaled[indices[1]! * 3 + 1]!;
    const bz = scaled[indices[1]! * 3 + 2]!;
    const cx = scaled[indices[2]! * 3]!;
    const cy = scaled[indices[2]! * 3 + 1]!;
    const cz = scaled[indices[2]! * 3 + 2]!;

    let fnx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let fny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let fnz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const faceLength = Math.hypot(fnx, fny, fnz) || 1;
    fnx /= faceLength;
    fny /= faceLength;
    fnz /= faceLength;

    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indices[corner]!;
      const target = f * 9 + corner * 3;

      positions[target] = scaled[vertex * 3]!;
      positions[target + 1] = scaled[vertex * 3 + 1]!;
      positions[target + 2] = scaled[vertex * 3 + 2]!;

      // Blend smooth → flat. At faceting 0 the stone is a smooth cobble; at 1
      // every triangle is flat-shaded like a fresh fracture.
      const sx = smoothNormals[vertex * 3]!;
      const sy = smoothNormals[vertex * 3 + 1]!;
      const sz = smoothNormals[vertex * 3 + 2]!;

      let bnx = mix(sx, fnx, faceting);
      let bny = mix(sy, fny, faceting);
      let bnz = mix(sz, fnz, faceting);
      const blendLength = Math.hypot(bnx, bny, bnz) || 1;
      bnx /= blendLength;
      bny /= blendLength;
      bnz /= blendLength;

      normals[target] = bnx;
      normals[target + 1] = bny;
      normals[target + 2] = bnz;

      // ---- colour ----
      const dx = sphere.vertices[vertex * 3]!;
      const dy = sphere.vertices[vertex * 3 + 1]!;
      const dz = sphere.vertices[vertex * 3 + 2]!;

      // Mineral veining: a sharpened noise field so the accent appears as
      // discrete inclusions rather than an even wash.
      const veinRaw = detailNoise.fbm(dx * 6.5, dy * 6.5, dz * 6.5, 3) * 0.5 + 0.5;
      const vein = speckle * smoothstep(0.52, 0.78, veinRaw);

      // Crevice shading: recessed areas keep less light. A cheap stand-in for
      // ambient occlusion that costs nothing at render time.
      const relief = (radii[vertex]! - minRadius) / radiusSpan;
      const cavity = 0.74 + 0.26 * relief;

      colors[target] = mix(base[0], accent[0], vein) * cavity;
      colors[target + 1] = mix(base[1], accent[1], vein) * cavity;
      colors[target + 2] = mix(base[2], accent[2], vein) * cavity;
    }
  }

  return {
    positions,
    normals,
    colors,
    triangleCount,
    bounds: {
      length: params.dimensions.length_mm,
      width: params.dimensions.width_mm,
      height: params.dimensions.height_mm,
    },
  };
}
