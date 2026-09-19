/**
 * Seeded pseudo-random numbers and 3D gradient noise.
 *
 * Everything here is deterministic: the same seed produces the same
 * permutation table, and therefore the same stone. That is what makes a set of
 * coordinates reproduce its model, and what makes a shared link show the
 * recipient exactly what the author saw — only the parameters travel, never the
 * mesh.
 *
 * No dependency: a noise library would be more code than this file for the one
 * function the generator needs.
 */

/** xmur3 — string to a well-distributed 32-bit seed. */
export function hashSeed(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 — small, fast, good enough for geometry. */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRADIENTS = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1,
  0, 1, -1, 0, -1, -1,
]);

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number): number => a + t * (b - a);

/**
 * Classic Perlin gradient noise in three dimensions, with a seeded permutation.
 *
 * Returns roughly [-1, 1].
 */
export class Noise3D {
  readonly #perm: Uint8Array;

  constructor(seed: number) {
    const random = makeRandom(seed);
    const source = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) source[i] = i;

    // Fisher–Yates with the seeded generator.
    for (let i = 255; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const temp = source[i]!;
      source[i] = source[j]!;
      source[j] = temp;
    }

    // Doubled so lookups can index up to 511 without a modulo.
    this.#perm = new Uint8Array(512);
    for (let i = 0; i < 512; i += 1) this.#perm[i] = source[i & 255]!;
  }

  #grad(hash: number, x: number, y: number, z: number): number {
    const index = (hash % 12) * 3;
    return (
      GRADIENTS[index]! * x + GRADIENTS[index + 1]! * y + GRADIENTS[index + 2]! * z
    );
  }

  sample(x: number, y: number, z: number): number {
    const perm = this.#perm;

    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const zi = Math.floor(z) & 255;

    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const zf = z - Math.floor(z);

    const u = fade(xf);
    const v = fade(yf);
    const w = fade(zf);

    const a = perm[xi]! + yi;
    const aa = perm[a]! + zi;
    const ab = perm[a + 1]! + zi;
    const b = perm[xi + 1]! + yi;
    const ba = perm[b]! + zi;
    const bb = perm[b + 1]! + zi;

    const x1 = lerp(
      this.#grad(perm[aa]!, xf, yf, zf),
      this.#grad(perm[ba]!, xf - 1, yf, zf),
      u,
    );
    const x2 = lerp(
      this.#grad(perm[ab]!, xf, yf - 1, zf),
      this.#grad(perm[bb]!, xf - 1, yf - 1, zf),
      u,
    );
    const y1 = lerp(x1, x2, v);

    const x3 = lerp(
      this.#grad(perm[aa + 1]!, xf, yf, zf - 1),
      this.#grad(perm[ba + 1]!, xf - 1, yf, zf - 1),
      u,
    );
    const x4 = lerp(
      this.#grad(perm[ab + 1]!, xf, yf - 1, zf - 1),
      this.#grad(perm[bb + 1]!, xf - 1, yf - 1, zf - 1),
      u,
    );
    const y2 = lerp(x3, x4, v);

    return lerp(y1, y2, w);
  }

  /**
   * Fractal Brownian motion: octaves of noise at doubling frequency and
   * halving amplitude. This is what turns smooth noise into something that
   * reads as rock rather than as a lava lamp — natural surfaces have detail at
   * every scale.
   */
  fbm(x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amplitude = 1;
    let frequency = 1;
    let total = 0;
    let normalisation = 0;

    for (let octave = 0; octave < octaves; octave += 1) {
      total += this.sample(x * frequency, y * frequency, z * frequency) * amplitude;
      normalisation += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }

    return normalisation > 0 ? total / normalisation : 0;
  }

  /**
   * Ridged noise — the absolute value inverted, which produces creases rather
   * than blobs. Used for the eroded channels on a weathered surface.
   */
  ridged(x: number, y: number, z: number, octaves: number): number {
    let amplitude = 1;
    let frequency = 1;
    let total = 0;
    let normalisation = 0;

    for (let octave = 0; octave < octaves; octave += 1) {
      const value = 1 - Math.abs(this.sample(x * frequency, y * frequency, z * frequency));
      total += value * value * amplitude;
      normalisation += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }

    return normalisation > 0 ? total / normalisation : 0;
  }
}

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
};

export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
