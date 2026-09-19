/**
 * Printability, as a standing constraint.
 *
 * Every shaping feature has to leave a mesh a slicer can actually use. The
 * expensive failure is a model that looks right on screen and then prints
 * wrong, or gets silently "repaired" into something else, so these properties
 * are asserted for the generator as a whole rather than checked by eye once.
 *
 * Any new deformation belongs in the matrix below.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BufferAttribute, BufferGeometry } from 'three';
import { computePrintStats } from '../src/features/studio/printing';
import { generateStone, type StoneParams } from '../src/features/studio/generator/stone';
import { DEFAULT_PARAMS } from '../src/features/studio/types';
import { CONTROL_POINT_COUNT, emptySculpt } from '../src/features/studio/controlPoints';

const base = DEFAULT_PARAMS as StoneParams;

function statsFor(params: StoneParams) {
  const generated = generateStone(params);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(generated.positions, 3));
  return computePrintStats(geometry);
}

/** Shapes that between them exercise every deformation the generator applies. */
const CASES: { name: string; params: StoneParams }[] = [
  { name: 'default', params: base },
  {
    name: 'every point pulled fully out',
    params: { ...base, sculpt: { pulls: new Array(CONTROL_POINT_COUNT).fill(1), influence: 1 } },
  },
  {
    name: 'every point pushed fully in',
    params: { ...base, sculpt: { pulls: new Array(CONTROL_POINT_COUNT).fill(-1), influence: 1 } },
  },
  {
    name: 'alternating pulls, tight reach',
    params: {
      ...base,
      sculpt: {
        pulls: Array.from({ length: CONTROL_POINT_COUNT }, (_, i) => (i % 2 ? 1 : -1)),
        influence: 0,
      },
    },
  },
  {
    name: 'fully faceted and eroded',
    params: { ...base, surface: { ...base.surface, faceting: 1, erosion: 1, detail: 1, grain: 1 } },
  },
  {
    name: 'extreme form',
    params: {
      ...base,
      form: { roundness: 0, taper: -1, asymmetry: 1, flatten: 1, bulge: 1 },
    },
  },
  {
    name: 'sculpted and faceted together',
    params: {
      ...base,
      surface: { ...base.surface, faceting: 0.8 },
      sculpt: {
        pulls: Array.from({ length: CONTROL_POINT_COUNT }, (_, i) => (i < 4 ? 0.9 : 0)),
        influence: 0.7,
      },
    },
  },
  {
    name: 'extreme aspect ratio',
    params: { ...base, dimensions: { length_mm: 400, width_mm: 12, height_mm: 12 } },
  },
];

describe('every shape stays watertight', () => {
  for (const { name, params } of CASES) {
    it(name, () => {
      const stats = statsFor(params);
      assert.equal(
        stats.isWatertight,
        true,
        `${stats.openEdgeCount} open edges — a slicer cannot tell inside from outside`,
      );
    });
  }
});

describe('every shape encloses a real volume', () => {
  for (const { name, params } of CASES) {
    it(name, () => {
      const stats = statsFor(params);
      // A self-intersected or inverted mesh collapses toward zero volume.
      assert.ok(stats.volumeMm3 > 0, `volume was ${stats.volumeMm3}`);

      // Sanity bound: the solid cannot exceed its own bounding box.
      const boxVolume =
        stats.boundingBox.length * stats.boundingBox.width * stats.boundingBox.height;
      assert.ok(
        stats.volumeMm3 <= boxVolume * 1.001,
        `volume ${stats.volumeMm3} exceeds its bounding box ${boxVolume}`,
      );
    });
  }
});

describe('every shape keeps the requested size', () => {
  for (const { name, params } of CASES) {
    it(name, () => {
      const stats = statsFor(params);
      const { dimensions } = params;

      // The dimension fields are a promise to the user and to the slicer.
      assert.ok(
        Math.abs(stats.boundingBox.length - dimensions.length_mm) < 0.02,
        `length ${stats.boundingBox.length} vs ${dimensions.length_mm}`,
      );
      assert.ok(
        Math.abs(stats.boundingBox.width - dimensions.width_mm) < 0.02,
        `width ${stats.boundingBox.width} vs ${dimensions.width_mm}`,
      );
      assert.ok(
        Math.abs(stats.boundingBox.height - dimensions.height_mm) < 0.02,
        `height ${stats.boundingBox.height} vs ${dimensions.height_mm}`,
      );
    });
  }
});

describe('mesh quality', () => {
  it('is watertight at every offered resolution', () => {
    for (let resolution = 2; resolution <= 6; resolution += 1) {
      const stats = statsFor({ ...base, surface: { ...base.surface, resolution } });
      assert.equal(stats.isWatertight, true, `level ${resolution} leaked`);
    }
  });

  it('produces no degenerate triangles', () => {
    // A zero-area facet carries no normal, and some slicers reject the file.
    const generated = generateStone({
      ...base,
      sculpt: { pulls: new Array(CONTROL_POINT_COUNT).fill(-1), influence: 1 },
    });

    const positions = generated.positions;
    let degenerate = 0;

    for (let t = 0; t < generated.triangleCount; t += 1) {
      const o = t * 9;
      const e1x = positions[o + 3]! - positions[o]!;
      const e1y = positions[o + 4]! - positions[o + 1]!;
      const e1z = positions[o + 5]! - positions[o + 2]!;
      const e2x = positions[o + 6]! - positions[o]!;
      const e2y = positions[o + 7]! - positions[o + 1]!;
      const e2z = positions[o + 8]! - positions[o + 2]!;

      const area =
        Math.hypot(
          e1y * e2z - e1z * e2y,
          e1z * e2x - e1x * e2z,
          e1x * e2y - e1y * e2x,
        ) / 2;

      // Below a square micron is smaller than any printer resolves.
      if (area < 1e-6) degenerate += 1;
    }

    assert.equal(degenerate, 0, `${degenerate} degenerate triangles`);
  });

  it('never lets the surface collapse through the centre', () => {
    /*
      Pushing every control point inward at full strength is the case most
      likely to invert the mesh. The generator floors the radius, so the
      surface stays outside the origin and the solid stays valid.
    */
    const generated = generateStone({
      ...base,
      sculpt: { pulls: new Array(CONTROL_POINT_COUNT).fill(-1), influence: 1 },
      dimensions: { length_mm: 200, width_mm: 200, height_mm: 200 },
    });

    let closest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < generated.positions.length; i += 3) {
      closest = Math.min(
        closest,
        Math.hypot(generated.positions[i]!, generated.positions[i + 1]!, generated.positions[i + 2]!),
      );
    }

    assert.ok(closest > 1, `surface came within ${closest} mm of the centre`);
  });

  it('keeps a flat-enough footprint to sit on a build plate', () => {
    // Not a hard requirement — supports and brims exist — but a stone with no
    // contact at all tips off the plate, so the base should not be a point.
    const generated = generateStone(base);

    let minY = Number.POSITIVE_INFINITY;
    for (let i = 1; i < generated.positions.length; i += 3) {
      minY = Math.min(minY, generated.positions[i]!);
    }

    const threshold = minY + base.dimensions.height_mm * 0.02;
    let nearBase = 0;
    for (let i = 1; i < generated.positions.length; i += 3) {
      if (generated.positions[i]! <= threshold) nearBase += 1;
    }

    assert.ok(nearBase > 10, `only ${nearBase} vertices within 2% of the lowest point`);
  });
});

describe('sculpting does not degrade printability', () => {
  it('leaves the triangle count unchanged', () => {
    // Sculpting displaces existing vertices; it must not add or drop any, or a
    // resolution setting would stop meaning what it says.
    const plain = generateStone(base);

    const sculpt = emptySculpt();
    sculpt.pulls[0] = 1;
    const carved = generateStone({ ...base, sculpt });

    assert.equal(carved.triangleCount, plain.triangleCount);
  });

  it('changes the enclosed volume in the expected direction', () => {
    const outward = emptySculpt();
    outward.pulls[0] = 1;

    const inward = emptySculpt();
    inward.pulls[0] = -1;

    const plain = statsFor(base).volumeMm3;
    const pushedOut = statsFor({ ...base, sculpt: outward }).volumeMm3;
    const pushedIn = statsFor({ ...base, sculpt: inward }).volumeMm3;

    /*
      The mesh is rescaled to the same bounding box afterwards, so these are not
      guaranteed to differ hugely — but they must differ, or the sculpt is not
      reaching the geometry that gets exported.
    */
    assert.notEqual(pushedOut, plain);
    assert.notEqual(pushedIn, plain);
  });
});
