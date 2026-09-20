/**
 * Turning measured ground into a stone.
 *
 * The coordinates already seeded the noise, so a place always produced the
 * *same* stone. They did not make it that place's stone: every location got
 * the same distribution of shapes, just shuffled differently. This module
 * closes that gap by reading the real elevation around the pin and letting the
 * landform decide the proportions, the surface, and the silhouette.
 *
 * Two rules keep the result honest and usable:
 *
 *   1. **Length is preserved.** Every other dimension is expressed as a ratio
 *      of it. The user chose how big to print; the ground decides the shape,
 *      not the scale.
 *   2. **The underside flattens regardless.** Terrain pulls fade to nothing at
 *      the bottom pole, so the stone keeps a face to sit on. A faithful
 *      transcription of a hillside onto a sphere would produce something that
 *      needs support material everywhere, which is a worse stone and a worse
 *      print.
 *
 * Everything here is pure arithmetic over a sampled grid, so what a place
 * turns into is testable without touching the network.
 */
import type { DesignParams } from '../../data/types';
import type { GroundColour } from '../../data/geo';
import { type TerrainSample, type TerrainSummary, heightAt } from '../../data/terrain';
import { CONTROL_POINT_DIRECTIONS, emptySculpt } from './controlPoints';

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const clamp01 = (value: number): number => clamp(value, 0, 1);

/** Linear remap with clamping at both ends. */
const remap = (value: number, inLow: number, inHigh: number): number =>
  clamp01((value - inLow) / (inHigh - inLow));

/**
 * Relief as a fraction of the window it was measured over.
 *
 * Absolute relief cannot be compared across places — 200 m is a mountain in a
 * two-kilometre window and a gentle rise in a fifty-kilometre one. The ratio
 * is what actually describes the terrain, and it is what every shape decision
 * below is built on.
 *
 * The scale is calibrated against real ground: a floodplain sits near 0.002,
 * rolling farmland near 0.03, a river gorge near 0.12, and an alpine face
 * above 0.25.
 */
export function ruggednessOf(summary: TerrainSummary, sample: TerrainSample): number {
  return clamp01(summary.relief / sample.spanMeters / 0.22);
}

/**
 * How stretched the landform is, and which way.
 *
 * Measured by comparing the spread of elevation along the downhill axis with
 * the spread across it. A ridge or valley varies strongly across its axis and
 * barely along it; a dome varies the same in both.
 *
 * Returns 1 for perfectly round ground and falls toward 0 as the landform
 * becomes more linear.
 */
export function elongationOf(sample: TerrainSample, summary: TerrainSummary): number {
  const bearing = (summary.aspectDegrees * Math.PI) / 180;
  const alongEast = Math.sin(bearing);
  const alongNorth = Math.cos(bearing);

  const SAMPLES = 24;
  let alongSpread = 0;
  let acrossSpread = 0;

  for (let index = 0; index < SAMPLES; index += 1) {
    // −0.9 to 0.9: the outermost ring of the window is the least reliable,
    // since it is where the fetched square was cropped.
    const t = (index / (SAMPLES - 1)) * 1.8 - 0.9;

    const along = heightAt(sample, alongEast * t, alongNorth * t);
    // Perpendicular axis: rotate the bearing by a quarter turn.
    const across = heightAt(sample, alongNorth * t, -alongEast * t);

    alongSpread += Math.abs(along - summary.meanElevation);
    acrossSpread += Math.abs(across - summary.meanElevation);
  }

  const larger = Math.max(alongSpread, acrossSpread);
  if (larger < 1e-6) return 1;

  return clamp01(Math.min(alongSpread, acrossSpread) / larger);
}

/**
 * Whether the pin sits on a rise or in a hollow, −1 to 1.
 *
 * The centre is compared with the ring around it, which is the same question a
 * hilltop and a basin answer with opposite signs.
 */
export function convexityOf(sample: TerrainSample, summary: TerrainSummary): number {
  if (summary.relief < 1e-6) return 0;

  const RING = 12;
  let ringTotal = 0;

  for (let index = 0; index < RING; index += 1) {
    const angle = (index / RING) * Math.PI * 2;
    ringTotal += heightAt(sample, Math.cos(angle) * 0.75, Math.sin(angle) * 0.75);
  }

  const centre = heightAt(sample, 0, 0);
  return clamp((centre - ringTotal / RING) / (summary.relief / 2), -1, 1);
}

/**
 * Terrain heights as control-point pulls.
 *
 * Each handle's direction is projected onto the ground plane and the elevation
 * read there, so the stone's silhouette follows the landform around it. Two
 * deliberate departures from a literal transcription:
 *
 *   - Influence fades with height, reaching zero at the bottom pole. The top
 *     of a stone can echo a ridge; its underside has to sit on a table and,
 *     more pressingly, on a print bed.
 *   - Pulls are scaled so the strongest is near full range. Real terrain in a
 *     small window rarely spans its own relief at the handles, and without
 *     this the shaping would be too faint to see.
 */
export function pullsFromTerrain(sample: TerrainSample, summary: TerrainSummary): number[] {
  const halfRelief = summary.relief / 2;
  if (halfRelief < 1e-6) return CONTROL_POINT_DIRECTIONS.map(() => 0);

  const raw = CONTROL_POINT_DIRECTIONS.map(([x, y, z]) => {
    // The generator's +x runs east and −z runs north, matching how the
    // viewport is framed against the map.
    const height = heightAt(sample, x, -z);
    const offset = (height - summary.meanElevation) / halfRelief;

    const weight = y >= 0 ? 0.45 + 0.55 * y : 0.45 * (1 + y);
    return clamp(offset, -1, 1) * weight;
  });

  const strongest = raw.reduce((peak, pull) => Math.max(peak, Math.abs(pull)), 0);
  if (strongest < 1e-6) return raw;

  // Normalise to a consistent presence rather than to 1: filling the range
  // every time would make a gentle hill as dramatic as a cliff.
  const gain = Math.min(0.85 / strongest, 3);
  return raw.map((pull) => clamp(pull * gain, -1, 1));
}

/** A short name for the kind of place this is, for the UI to show back. */
export function characteriseTerrain(summary: TerrainSummary, ruggedness: number): string {
  if (summary.flat) return 'Flat ground';
  if (ruggedness > 0.72) return summary.roughness > 0.5 ? 'Alpine, broken' : 'Alpine, sheer';
  if (ruggedness > 0.42) return summary.roughness > 0.5 ? 'Steep and rocky' : 'Steep hillside';
  if (ruggedness > 0.18) return summary.roughness > 0.55 ? 'Rough upland' : 'Rolling hills';
  return summary.roughness > 0.5 ? 'Low and broken' : 'Gentle ground';
}

export interface TerrainDerivation {
  params: DesignParams;
  /** What this place is, in two or three words. */
  character: string;
  /** Plain-language account of what the ground decided, for the panel. */
  notes: string[];
}

/**
 * Build a stone from a place.
 *
 * `base` supplies everything the ground has no opinion about — most
 * importantly the printed length, and the material when no imagery came back.
 */
export function deriveStoneFromTerrain(
  base: DesignParams,
  sample: TerrainSample,
  summary: TerrainSummary,
  ground: GroundColour | null,
): TerrainDerivation {
  const ruggedness = ruggednessOf(summary, sample);
  const elongation = elongationOf(sample, summary);
  const convexity = convexityOf(sample, summary);
  const steepness = remap(summary.slopeDegrees, 1, 34);

  const length = base.dimensions.length_mm;

  // Flat country gives a low, wide stone; a mountain gives a tall, narrow one.
  const heightRatio = 0.3 + ruggedness * 0.62;
  // A ridge makes a narrow stone, a dome a round one. Floored so nothing comes
  // out as a blade that will not stand up.
  const widthRatio = 0.5 + elongation * 0.34;

  const notes: string[] = [];

  notes.push(
    summary.flat
      ? `Barely ${summary.relief.toFixed(0)} m of relief across ${(sample.spanMeters / 1000).toFixed(1)} km — a low, wide stone.`
      : `${summary.relief.toFixed(0)} m of relief across ${(sample.spanMeters / 1000).toFixed(1)} km sets the height at ${(heightRatio * 100).toFixed(0)}% of the length.`,
  );

  notes.push(
    elongation < 0.6
      ? 'The land runs as a ridge rather than a dome, so the stone is narrowed across it.'
      : 'Relief is even in every direction, so the stone stays broad.',
  );

  notes.push(
    summary.roughness > 0.5
      ? 'Broken, high-frequency ground — the surface takes coarse grain and sharper faces.'
      : 'Smooth ground — the surface is worn back and rounded off.',
  );

  if (!summary.flat) {
    notes.push(
      convexity > 0.15
        ? 'The pin sits on a rise, which bulges the stone outward.'
        : convexity < -0.15
          ? 'The pin sits in a hollow, which pulls the stone in at the waist.'
          : `The ground falls away toward ${compassOf(summary.aspectDegrees)}, and the stone leans with it.`,
    );
  }

  const params: DesignParams = {
    ...base,
    dimensions: {
      length_mm: length,
      width_mm: Math.round(length * widthRatio),
      height_mm: Math.round(length * heightRatio),
    },
    form: {
      // Smooth ground wears round; broken ground keeps its corners.
      roundness: clamp01(0.75 - summary.roughness * 0.45),
      // A consistent fall across the window becomes a consistent taper.
      taper: clamp(-0.32 * steepness * Math.sign(convexity || 1), -1, 1),
      // Steep, uneven ground produces a lopsided stone.
      asymmetry: clamp01(0.18 + steepness * 0.4 + summary.roughness * 0.22),
      // Flat country gives a flat stone. This is the strongest single signal.
      flatten: clamp01(0.68 - ruggedness * 0.6),
      bulge: clamp01(0.3 + convexity * 0.35),
    },
    surface: {
      ...base.surface,
      detail: clamp01(0.25 + summary.roughness * 0.62),
      grain: clamp01(0.2 + summary.roughness * 0.7),
      // Roughness and erosion are opposites: what is still broken has not worn.
      erosion: clamp01(0.72 - summary.roughness * 0.6),
      // Cliffs and scree — steep *and* broken — is where facets belong.
      faceting: clamp01(steepness * summary.roughness * 1.3 - 0.1),
    },
    material: ground ? { ...base.material, ...ground } : base.material,
  };

  if (ground) {
    notes.push('Colour is averaged from the aerial imagery at the pin, muted to a stone range.');
  }

  return {
    params: {
      ...params,
      // The influence radius is the user's setting, not the ground's; only
      // the pulls are being replaced.
      sculpt: { ...(base.sculpt ?? emptySculpt()), pulls: pullsFromTerrain(sample, summary) },
    },
    character: characteriseTerrain(summary, ruggedness),
    notes,
  };
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

export function compassOf(degrees: number): string {
  const index = Math.round((((degrees % 360) + 360) % 360) / 45) % 8;
  return COMPASS[index]!;
}
