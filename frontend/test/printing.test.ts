/**
 * 3D-printing export.
 *
 * Errors here are expensive in a way UI bugs are not: a wrong scale or a
 * mis-detected hole is discovered hours into a print. The volume and
 * watertight checks are therefore tested against shapes whose answers are
 * known by hand rather than by running the code and recording what it said.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BufferAttribute, BufferGeometry } from 'three';
import { MATERIALS, buildStl, computePrintStats, estimateMass } from '../src/features/studio/printing';

/**
 * A closed axis-aligned cube as a non-indexed triangle soup, matching what the
 * generator produces. Side length `s`, corner at the origin.
 */
function cube(s: number): BufferGeometry {
  const v = [
    [0, 0, 0],
    [s, 0, 0],
    [s, s, 0],
    [0, s, 0],
    [0, 0, s],
    [s, 0, s],
    [s, s, s],
    [0, s, s],
  ];

  // Outward-facing winding on every face.
  const faces = [
    [0, 3, 2], [0, 2, 1], // z = 0
    [4, 5, 6], [4, 6, 7], // z = s
    [0, 1, 5], [0, 5, 4], // y = 0
    [3, 7, 6], [3, 6, 2], // y = s
    [0, 4, 7], [0, 7, 3], // x = 0
    [1, 2, 6], [1, 6, 5], // x = s
  ];

  const positions: number[] = [];
  for (const [a, b, c] of faces) {
    positions.push(...v[a!]!, ...v[b!]!, ...v[c!]!);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  return geometry;
}

/** The same cube with one face removed, so it has a hole. */
function openCube(s: number): BufferGeometry {
  const full = cube(s);
  const array = full.getAttribute('position').array as Float32Array;
  // Drop the last two triangles (18 floats).
  const trimmed = array.slice(0, array.length - 18);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(trimmed, 3));
  return geometry;
}

describe('computePrintStats', () => {
  it('measures the volume of a known solid', () => {
    const stats = computePrintStats(cube(10));
    // 10 mm cube is exactly 1000 mm³.
    assert.ok(Math.abs(stats.volumeMm3 - 1000) < 0.01, `got ${stats.volumeMm3}`);
  });

  it('measures surface area', () => {
    const stats = computePrintStats(cube(10));
    // Six faces of 100 mm².
    assert.ok(Math.abs(stats.surfaceAreaMm2 - 600) < 0.01, `got ${stats.surfaceAreaMm2}`);
  });

  it('reports the bounding box in millimetres', () => {
    const stats = computePrintStats(cube(25));
    assert.ok(Math.abs(stats.boundingBox.length - 25) < 0.001);
    assert.ok(Math.abs(stats.boundingBox.width - 25) < 0.001);
    assert.ok(Math.abs(stats.boundingBox.height - 25) < 0.001);
  });

  it('recognises a closed mesh as watertight', () => {
    const stats = computePrintStats(cube(10));
    assert.equal(stats.isWatertight, true);
    assert.equal(stats.openEdgeCount, 0);
  });

  it('detects a hole', () => {
    const stats = computePrintStats(openCube(10));
    assert.equal(stats.isWatertight, false);
    assert.ok(stats.openEdgeCount > 0, 'open edges are counted');
  });

  it('counts triangles', () => {
    assert.equal(computePrintStats(cube(10)).triangleCount, 12);
  });

  it('reports a positive volume regardless of winding', () => {
    // A mesh wound inward yields a negative signed volume; the absolute value
    // is what a user cares about.
    const geometry = cube(10);
    const array = geometry.getAttribute('position').array as Float32Array;
    for (let t = 0; t < array.length; t += 9) {
      // Swap two vertices of each triangle to reverse the winding.
      for (let i = 0; i < 3; i += 1) {
        const a = array[t + 3 + i]!;
        array[t + 3 + i] = array[t + 6 + i]!;
        array[t + 6 + i] = a;
      }
    }
    assert.ok(computePrintStats(geometry).volumeMm3 > 0);
  });
});

describe('estimateMass', () => {
  it('scales with volume and density', () => {
    const pla = MATERIALS.find((entry) => entry.id === 'pla')!;
    // 100 cm³ solid PLA is 124 g.
    const solid = estimateMass(100_000, pla.density, 1);
    assert.ok(Math.abs(solid - 124) < 0.01, `got ${solid}`);
  });

  it('reports less at lower infill, but never zero', () => {
    const pla = MATERIALS.find((entry) => entry.id === 'pla')!;
    const solid = estimateMass(100_000, pla.density, 1);
    const hollow = estimateMass(100_000, pla.density, 0);

    assert.ok(hollow < solid, 'infill reduces mass');
    // The shell prints solid whatever the infill, so zero infill is not zero
    // material.
    assert.ok(hollow > 0, 'a zero-infill print still uses filament');
  });

  it('is monotonic in infill', () => {
    const pla = MATERIALS.find((entry) => entry.id === 'pla')!;
    let previous = 0;
    for (const infill of [0, 0.15, 0.3, 0.6, 1]) {
      const mass = estimateMass(50_000, pla.density, infill);
      assert.ok(mass >= previous, `mass fell at infill ${infill}`);
      previous = mass;
    }
  });
});

describe('buildStl', () => {
  it('writes a correctly sized binary STL', () => {
    const buffer = buildStl(cube(10), 'test');
    // 80-byte header + 4-byte count + 50 bytes per triangle.
    assert.equal(buffer.byteLength, 84 + 12 * 50);
  });

  it('records the triangle count in the header', () => {
    const view = new DataView(buildStl(cube(10), 'test'));
    assert.equal(view.getUint32(80, true), 12);
  });

  it('does not start the header with "solid"', () => {
    const buffer = buildStl(cube(10), 'test');
    const header = new TextDecoder().decode(new Uint8Array(buffer, 0, 5));
    // A binary STL beginning with "solid" makes parsers guess ASCII.
    assert.notEqual(header.toLowerCase(), 'solid');
  });

  it('exports at true millimetre scale', () => {
    const view = new DataView(buildStl(cube(37), 'test'));

    let maxCoordinate = 0;
    for (let t = 0; t < 12; t += 1) {
      const base = 84 + t * 50 + 12; // skip the facet normal
      for (let i = 0; i < 9; i += 1) {
        maxCoordinate = Math.max(maxCoordinate, Math.abs(view.getFloat32(base + i * 4, true)));
      }
    }

    // A 37 mm cube must export as 37 units, not 0.037 or 37000.
    assert.ok(Math.abs(maxCoordinate - 37) < 0.001, `largest coordinate was ${maxCoordinate}`);
  });

  it('rotates Y-up to the Z-up convention slicers expect', () => {
    // A slab twice as tall as it is deep: 10 wide, 20 tall (Y), 10 deep (Z).
    const geometry = new BufferGeometry();
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 20, 0]);
    geometry.setAttribute('position', new BufferAttribute(positions, 3));

    const view = new DataView(buildStl(geometry, 'test'));
    const base = 84 + 12;

    // Third vertex was (10, 20, 0); under (x, y, z) → (x, −z, y) it becomes
    // (10, 0, 20), putting the height on Z where a slicer expects it.
    //
    // Compared with `===` rather than assert.equal: negating a zero coordinate
    // yields -0, which Object.is distinguishes from 0 but which is the same
    // value to every float comparison and every STL parser.
    assert.ok(view.getFloat32(base + 24, true) === 10);
    assert.ok(view.getFloat32(base + 28, true) === 0, 'depth maps to zero');
    assert.ok(view.getFloat32(base + 32, true) === 20, 'height maps to Z');
  });

  it('writes unit-length facet normals', () => {
    const view = new DataView(buildStl(cube(10), 'test'));

    for (let t = 0; t < 12; t += 1) {
      const base = 84 + t * 50;
      const length = Math.hypot(
        view.getFloat32(base, true),
        view.getFloat32(base + 4, true),
        view.getFloat32(base + 8, true),
      );
      assert.ok(Math.abs(length - 1) < 1e-5, `facet ${t} normal length ${length}`);
    }
  });

  it('zeroes the attribute byte count', () => {
    const view = new DataView(buildStl(cube(10), 'test'));
    for (let t = 0; t < 12; t += 1) {
      assert.equal(view.getUint16(84 + t * 50 + 48, true), 0);
    }
  });
});
