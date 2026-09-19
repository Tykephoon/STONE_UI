/**
 * Studio parameter defaults, presets, and client-side validation.
 *
 * The shapes mirror `backend/src/domain/design.ts`, which is the authoritative
 * validator. Validation here exists so a bad value is caught before a round
 * trip, not so the server can trust the client.
 */
import type { DesignParams } from '../../api/types';

export const DIMENSION_LIMITS = { min: 1, max: 10_000 } as const;
export const RESOLUTION_LIMITS = { min: 2, max: 6 } as const;

/**
 * Derive the generator seed from coordinates.
 *
 * Rounded to five decimal places — about a metre — so that nudging the pin by a
 * hand's width does not produce a different stone, while genuinely different
 * places do.
 */
export function seedFromCoordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
}

export const DEFAULT_PARAMS: DesignParams = {
  seed: seedFromCoordinates(42.3398, -71.0892),
  dimensions: {
    length_mm: 220,
    width_mm: 160,
    height_mm: 120,
  },
  form: {
    roundness: 0.55,
    taper: 0,
    asymmetry: 0.35,
    flatten: 0.2,
    bulge: 0.3,
  },
  surface: {
    detail: 0.55,
    grain: 0.45,
    erosion: 0.3,
    faceting: 0,
    resolution: 5,
  },
  material: {
    color: '#8a8577',
    accentColor: '#5c5850',
    roughness: 0.88,
    metalness: 0.03,
    speckle: 0.35,
    clearcoat: 0,
  },
};

export interface StonePreset {
  id: string;
  name: string;
  description: string;
  /** Applied over the current parameters; seed and dimensions are preserved. */
  patch: Pick<DesignParams, 'form' | 'surface' | 'material'>;
}

export const PRESETS: StonePreset[] = [
  {
    id: 'river',
    name: 'River cobble',
    description: 'Water-worn, smooth, flattened base.',
    patch: {
      form: { roundness: 0.78, taper: 0.05, asymmetry: 0.28, flatten: 0.38, bulge: 0.42 },
      surface: { detail: 0.3, grain: 0.35, erosion: 0.72, faceting: 0, resolution: 5 },
      material: {
        color: '#7d7a72',
        accentColor: '#4f4c46',
        roughness: 0.7,
        metalness: 0.02,
        speckle: 0.22,
        clearcoat: 0.18,
      },
    },
  },
  {
    id: 'granite',
    name: 'Fractured granite',
    description: 'Sharp faces, coarse grain, mineral flecks.',
    patch: {
      form: { roundness: 0.35, taper: -0.12, asymmetry: 0.52, flatten: 0.12, bulge: 0.2 },
      surface: { detail: 0.72, grain: 0.68, erosion: 0.08, faceting: 0.62, resolution: 5 },
      material: {
        color: '#8d8a86',
        accentColor: '#3b3a3d',
        roughness: 0.92,
        metalness: 0.06,
        speckle: 0.62,
        clearcoat: 0,
      },
    },
  },
  {
    id: 'sandstone',
    name: 'Weathered sandstone',
    description: 'Soft edges, layered wear, warm tone.',
    patch: {
      form: { roundness: 0.52, taper: 0.18, asymmetry: 0.44, flatten: 0.46, bulge: 0.34 },
      surface: { detail: 0.62, grain: 0.74, erosion: 0.56, faceting: 0.14, resolution: 5 },
      material: {
        color: '#a8886a',
        accentColor: '#7a5d44',
        roughness: 0.95,
        metalness: 0.01,
        speckle: 0.44,
        clearcoat: 0,
      },
    },
  },
  {
    id: 'basalt',
    name: 'Volcanic basalt',
    description: 'Dark, pitted, heavily textured.',
    patch: {
      form: { roundness: 0.42, taper: -0.05, asymmetry: 0.6, flatten: 0.18, bulge: 0.26 },
      surface: { detail: 0.9, grain: 0.85, erosion: 0.22, faceting: 0.34, resolution: 6 },
      material: {
        color: '#3c3d42',
        accentColor: '#22232a',
        roughness: 0.97,
        metalness: 0.04,
        speckle: 0.5,
        clearcoat: 0,
      },
    },
  },
  {
    id: 'slate',
    name: 'Cleaved slate',
    description: 'Flat, angular, cool grey.',
    patch: {
      form: { roundness: 0.3, taper: 0.08, asymmetry: 0.3, flatten: 0.72, bulge: 0.12 },
      surface: { detail: 0.4, grain: 0.3, erosion: 0.12, faceting: 0.82, resolution: 5 },
      material: {
        color: '#565b63',
        accentColor: '#33373d',
        roughness: 0.62,
        metalness: 0.08,
        speckle: 0.18,
        clearcoat: 0.22,
      },
    },
  },
];

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Coerce arbitrary parameters into the valid range.
 *
 * Applied to anything arriving from outside the editor — a shared URL, a saved
 * design from an older schema — so a malformed value produces a sensible stone
 * instead of a crash inside the generator.
 */
export function sanitiseParams(input: unknown): DesignParams {
  const fallback = DEFAULT_PARAMS;
  if (!input || typeof input !== 'object') return fallback;

  const raw = input as Partial<DesignParams>;
  const dimensions = raw.dimensions ?? fallback.dimensions;
  const form = raw.form ?? fallback.form;
  const surface = raw.surface ?? fallback.surface;
  const material = raw.material ?? fallback.material;

  const colour = (value: unknown, backup: string): string =>
    typeof value === 'string' && HEX.test(value) ? value : backup;

  return {
    seed:
      typeof raw.seed === 'string' && raw.seed.length > 0 && raw.seed.length <= 64
        ? raw.seed
        : fallback.seed,
    dimensions: {
      length_mm: clamp(Number(dimensions.length_mm), DIMENSION_LIMITS.min, DIMENSION_LIMITS.max),
      width_mm: clamp(Number(dimensions.width_mm), DIMENSION_LIMITS.min, DIMENSION_LIMITS.max),
      height_mm: clamp(Number(dimensions.height_mm), DIMENSION_LIMITS.min, DIMENSION_LIMITS.max),
    },
    form: {
      roundness: clamp(Number(form.roundness), 0, 1),
      taper: clamp(Number(form.taper), -1, 1),
      asymmetry: clamp(Number(form.asymmetry), 0, 1),
      flatten: clamp(Number(form.flatten), 0, 1),
      bulge: clamp(Number(form.bulge), 0, 1),
    },
    surface: {
      detail: clamp(Number(surface.detail), 0, 1),
      grain: clamp(Number(surface.grain), 0, 1),
      erosion: clamp(Number(surface.erosion), 0, 1),
      faceting: clamp(Number(surface.faceting), 0, 1),
      resolution: Math.round(
        clamp(Number(surface.resolution), RESOLUTION_LIMITS.min, RESOLUTION_LIMITS.max),
      ),
    },
    material: {
      color: colour(material.color, fallback.material.color),
      accentColor: colour(material.accentColor, fallback.material.accentColor),
      roughness: clamp(Number(material.roughness), 0, 1),
      metalness: clamp(Number(material.metalness), 0, 1),
      speckle: clamp(Number(material.speckle), 0, 1),
      clearcoat: clamp(Number(material.clearcoat), 0, 1),
    },
  };
}

/** Approximate triangle count for a subdivision level, for the UI's cost hint. */
export function trianglesForResolution(resolution: number): number {
  return 20 * 4 ** resolution;
}
