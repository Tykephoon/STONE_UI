/**
 * Hollowing, the base, and internal supports.
 *
 * The user's constraint is that printing correctly is imperative, so these are
 * the tests that stand between a design and a ruined print: the shell must
 * close, the wall must actually be the thickness asked for, the plug must
 * physically fit the hole, and a post must stop at the ceiling rather than
 * punching through the top of the stone.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BufferAttribute, BufferGeometry } from 'three';
import { computePrintStats } from '../src/features/studio/printing';
import { generateStone, type StoneParams } from '../src/features/studio/generator/stone';
import { DEFAULT_PARAMS } from '../src/features/studio/types';
import { MIN_WALL_MM, buildHollowShell } from '../src/features/studio/hollow';
import {
  buildBase,
  buildSupportPost,
  ceilingHeightAt,
  offsetLoop,
  pointInLoop,
  resampleLoop,
} from '../src/features/studio/baseAndSupports';

const base = DEFAULT_PARAMS as StoneParams;

/** Generate the solid and drop it onto y = 0, as the exporter does. */
function solid(params: StoneParams = base) {
  const generated = generateStone(params);
  const positions = new Float32Array(generated.positions);

  let minY = Number.POSITIVE_INFINITY;
  for (let i = 1; i < positions.length; i += 3) minY = Math.min(minY, positions[i]!);
  for (let i = 1; i < positions.length; i += 3) positions[i] = positions[i]! - minY;

  return { positions };
}

function statsOf(positions: Float32Array) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  return computePrintStats(geometry);
}

describe('hollow shell', () => {
  it('closes', () => {
    const { positions } = solid();
    const shell = buildHollowShell(positions, {
      wallThickness: 2.4,
      openingHeight: 20,
    });

    const stats = statsOf(shell.positions);
    assert.equal(
      stats.isWatertight,
      true,
      `${stats.openEdgeCount} open edges — the slicer could not fill this`,
    );
  });

  it('closes across a range of wall thicknesses', () => {
    const { positions } = solid();

    for (const wallThickness of [MIN_WALL_MM, 2, 3, 4, 6]) {
      const shell = buildHollowShell(positions, { wallThickness, openingHeight: 20 });
      const stats = statsOf(shell.positions);
      assert.equal(stats.isWatertight, true, `wall ${wallThickness} mm leaked`);
    }
  });

  it('closes across a range of opening heights, or refuses cleanly', () => {
    const { positions } = solid();

    for (const openingHeight of [2, 10, 20, 40, 60]) {
      const shell = buildHollowShell(positions, { wallThickness: 2.4, openingHeight });
      const stats = statsOf(shell.positions);

      /*
        Some cut heights graze a vertex where several triangles meet, leaving a
        boundary that is not a simple closed curve. Those are refused rather
        than approximated — but whichever path is taken, the mesh handed to a
        slicer must close.
      */
      assert.equal(
        stats.isWatertight,
        true,
        `opening at ${openingHeight} mm produced ${stats.openEdgeCount} open edges`,
      );
    }
  });

  it('actually hollows at the heights that matter', () => {
    const { positions } = solid();

    // Refusing is a safety valve, not the normal path: the useful middle of the
    // range must genuinely produce a vessel.
    for (const openingHeight of [10, 20, 40]) {
      const shell = buildHollowShell(positions, { wallThickness: 2.4, openingHeight });
      assert.equal(shell.feasible, true, `refused a reasonable opening at ${openingHeight} mm`);
    }
  });

  it('closes on a heavily sculpted stone', () => {
    const { positions } = solid({
      ...base,
      sculpt: { pulls: Array.from({ length: 14 }, (_, i) => (i % 2 ? 0.9 : -0.9)), influence: 0.7 },
    });

    const shell = buildHollowShell(positions, { wallThickness: 2.4, openingHeight: 20 });
    assert.equal(statsOf(shell.positions).isWatertight, true);
  });

  it('uses less material than the solid it came from', () => {
    const { positions } = solid();
    const shell = buildHollowShell(positions, {
      wallThickness: 2.4,
      openingHeight: 20,
    });

    const solidVolume = statsOf(positions).volumeMm3;
    const shellVolume = statsOf(shell.positions).volumeMm3;

    assert.ok(shellVolume < solidVolume, 'hollowing must remove material');
    // A 2.4 mm wall on a 220 mm stone should be a large saving, not a token one.
    assert.ok(
      shellVolume < solidVolume * 0.6,
      `only saved ${(100 - (shellVolume / solidVolume) * 100).toFixed(0)}%`,
    );
  });

  it('reports a cavity with room in it', () => {
    const { positions } = solid();
    const shell = buildHollowShell(positions, {
      wallThickness: 2.4,
      openingHeight: 20,
    });

    assert.ok(shell.cavityVolumeMm3 > 1000, `cavity was ${shell.cavityVolumeMm3} mm³`);
  });

  it('produces an opening large enough to reach into', () => {
    const { positions } = solid();
    const shell = buildHollowShell(positions, {
      wallThickness: 2.4,
      openingHeight: 20,
    });

    assert.ok(shell.innerLoop.points.length >= 3, 'inner rim did not form a ring');
    assert.ok(shell.outerLoop.points.length >= 3, 'outer rim did not form a ring');
  });

  it('refuses a wall too thick for the shape, rather than emitting a broken solid', () => {
    const { positions } = solid({
      ...base,
      dimensions: { length_mm: 60, width_mm: 30, height_mm: 20 },
    });

    // An 8 mm wall leaves no cavity inside a 20 mm tall stone.
    const shell = buildHollowShell(positions, { wallThickness: 8, openingHeight: 4 });

    assert.equal(shell.feasible, false, 'an impossible wall should be reported, not attempted');
    // And the fallback must still be a closed solid.
    assert.equal(statsOf(shell.positions).isWatertight, true);
  });

  it('raises a cut placed below the cavity floor', () => {
    const { positions } = solid();

    // Asking to cut 1 mm up with a 3 mm wall would pass through solid material.
    const shell = buildHollowShell(positions, { wallThickness: 3, openingHeight: 1 });

    assert.equal(shell.feasible, true, 'the cut should be raised, not abandoned');
    assert.equal(statsOf(shell.positions).isWatertight, true);
  });

  it('keeps the outer surface where it was', () => {
    const { positions } = solid();
    const shell = buildHollowShell(positions, {
      wallThickness: 2.4,
      openingHeight: 20,
    });

    const before = statsOf(positions).boundingBox;
    const after = statsOf(shell.positions).boundingBox;

    // Hollowing removes the underside, so height drops; the footprint must not.
    assert.ok(Math.abs(after.length - before.length) < 1, 'length changed');
    assert.ok(Math.abs(after.width - before.width) < 1, 'width changed');
    assert.ok(after.height < before.height, 'the opening should shorten it');
  });
});

describe('the base', () => {
  it('closes', () => {
    const { positions } = solid();
    const shell = buildHollowShell(positions, {
      wallThickness: 2.4,
      openingHeight: 20,
    });

    const plug = buildBase(shell.outerLoop, shell.innerLoop, {
      clearance: 0.2,
      plugDepth: 6,
      floorThickness: 2.5,
    });

    assert.equal(statsOf(plug.positions).isWatertight, true);
  });

  it('is smaller than the hole it goes into, by the clearance', () => {
    const { positions } = solid();
    const shell = buildHollowShell(positions, {
      wallThickness: 2.4,
      openingHeight: 20,
    });

    const cavity = resampleLoop(shell.innerLoop.points, 96);
    const clearance = 0.2;
    const plug = offsetLoop(cavity, clearance);

    // Every point of the plug must sit inside the cavity, or it will not go in.
    for (const point of plug) {
      assert.ok(
        pointInLoop(cavity, point.x, point.z),
        `plug point (${point.x.toFixed(2)}, ${point.z.toFixed(2)}) falls outside the cavity`,
      );
    }
  });

  it('gets tighter as clearance is reduced', () => {
    const { positions } = solid();
    const shell = buildHollowShell(positions, {
      wallThickness: 2.4,
      openingHeight: 20,
    });

    const area = (points: { x: number; z: number }[]) => {
      let total = 0;
      for (let i = 0; i < points.length; i += 1) {
        const a = points[i]!;
        const b = points[(i + 1) % points.length]!;
        total += a.x * b.z - b.x * a.z;
      }
      return Math.abs(total / 2);
    };

    const cavity = resampleLoop(shell.innerLoop.points, 96);
    const tight = area(offsetLoop(cavity, 0.1));
    const loose = area(offsetLoop(cavity, 0.35));

    assert.ok(tight > loose, 'a tighter fit should leave a larger plug');
  });

  it('prints flat side down, with its underside at zero', () => {
    const { positions } = solid();
    const shell = buildHollowShell(positions, {
      wallThickness: 2.4,
      openingHeight: 20,
    });

    const plug = buildBase(shell.outerLoop, shell.innerLoop, {
      clearance: 0.2,
      plugDepth: 6,
      floorThickness: 2.5,
    });

    let minY = Number.POSITIVE_INFINITY;
    for (let i = 1; i < plug.positions.length; i += 3) {
      minY = Math.min(minY, plug.positions[i]!);
    }

    assert.ok(Math.abs(minY) < 1e-6, `base sits at ${minY}, not on the plate`);
  });
});

describe('internal supports', () => {
  it('build a closed post', () => {
    const triangles = buildSupportPost(
      { id: 'a', x: 0, z: 0, diameter: 6 },
      0,
      40,
    );

    assert.ok(triangles.length > 0);
    assert.equal(statsOf(new Float32Array(triangles)).isWatertight, true);
  });

  it('refuse to build where there is no headroom', () => {
    // A post shorter than half a millimetre is a blob, not a support.
    const triangles = buildSupportPost({ id: 'a', x: 0, z: 0, diameter: 6 }, 10, 10.2);
    assert.equal(triangles.length, 0);
  });

  it('stop at the ceiling rather than punching through', () => {
    const { positions } = solid();
    const shell = buildHollowShell(positions, {
      wallThickness: 2.4,
      openingHeight: 20,
    });

    const ceiling = ceilingHeightAt(shell.positions, 0, 0, 20);
    assert.ok(ceiling !== null, 'no ceiling found above the centre of the cavity');

    const triangles = buildSupportPost({ id: 'a', x: 0, z: 0, diameter: 6 }, 20, ceiling!);

    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 1; i < triangles.length; i += 3) maxY = Math.max(maxY, triangles[i]!);

    assert.ok(maxY <= ceiling! + 1e-6, `post reached ${maxY}, ceiling is ${ceiling}`);
  });

  it('widen at the foot, where a print is most likely to let go', () => {
    const triangles = buildSupportPost({ id: 'a', x: 0, z: 0, diameter: 6 }, 0, 40);

    let footRadius = 0;
    let midRadius = 0;

    for (let i = 0; i < triangles.length; i += 3) {
      const radius = Math.hypot(triangles[i]!, triangles[i + 2]!);
      const y = triangles[i + 1]!;
      if (y < 0.01) footRadius = Math.max(footRadius, radius);
      if (y > 18 && y < 22) midRadius = Math.max(midRadius, radius);
    }

    assert.ok(footRadius > midRadius, 'the foot should flare');
  });

  it('stay watertight when several are combined with the shell', () => {
    const { positions } = solid();
    const shell = buildHollowShell(positions, {
      wallThickness: 2.4,
      openingHeight: 20,
    });

    const combined: number[] = Array.from(shell.positions);

    for (const [x, z] of [
      [0, 0],
      [25, 10],
      [-20, -15],
    ] as const) {
      const ceiling = ceilingHeightAt(shell.positions, x, z, 20);
      if (ceiling === null) continue;
      combined.push(...buildSupportPost({ id: `${x}`, x, z, diameter: 6 }, 20, ceiling));
    }

    /*
      Each body is closed on its own, so the combined file is too, even though
      the posts intersect the wall. Slicers union overlapping closed volumes at
      slice time, which is what makes this legitimate without a boolean.
    */
    const stats = statsOf(new Float32Array(combined));
    assert.equal(stats.isWatertight, true, `${stats.openEdgeCount} open edges`);
  });
});

describe('loop helpers', () => {
  it('offset a ring inward, not outward', () => {
    const square = [
      { x: -10, z: -10 },
      { x: 10, z: -10 },
      { x: 10, z: 10 },
      { x: -10, z: 10 },
    ];

    for (const point of offsetLoop(square, 2)) {
      assert.ok(Math.abs(point.x) < 10, `x grew to ${point.x}`);
      assert.ok(Math.abs(point.z) < 10, `z grew to ${point.z}`);
    }
  });

  it('offset inward regardless of winding', () => {
    const clockwise = [
      { x: -10, z: -10 },
      { x: -10, z: 10 },
      { x: 10, z: 10 },
      { x: 10, z: -10 },
    ];

    for (const point of offsetLoop(clockwise, 2)) {
      assert.ok(Math.abs(point.x) < 10 && Math.abs(point.z) < 10);
    }
  });

  it('resample to an exact count', () => {
    const triangle = [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 5, z: 8 },
    ];
    assert.equal(resampleLoop(triangle, 32).length, 32);
  });

  it('test containment correctly', () => {
    const square = [
      { x: -5, z: -5 },
      { x: 5, z: -5 },
      { x: 5, z: 5 },
      { x: -5, z: 5 },
    ];

    assert.equal(pointInLoop(square, 0, 0), true);
    assert.equal(pointInLoop(square, 9, 0), false);
  });
});
