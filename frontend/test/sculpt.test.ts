/**
 * Surface sculpting.
 *
 * The properties that matter are geometric rather than visual: a pull must
 * actually move the surface, move it *locally* rather than scaling the whole
 * stone, keep the requested bounding box, and stay deterministic so a shared
 * link reproduces it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONTROL_POINT_COUNT,
  CONTROL_POINT_DIRECTIONS,
  emptySculpt,
  influenceRadians,
  isSculpted,
  sanitiseSculpt,
  sculptDisplacement,
} from '../src/features/studio/controlPoints';
import { generateStone, type StoneParams } from '../src/features/studio/generator/stone';
import { DEFAULT_PARAMS } from '../src/features/studio/types';
import { decodeParams, encodeParams } from '../src/features/studio/exporters';

const base = DEFAULT_PARAMS as StoneParams;

function boundingBox(positions: Float32Array) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  return { length: maxX - minX, height: maxY - minY, width: maxZ - minZ };
}

describe('control point directions', () => {
  it('are unit vectors', () => {
    for (const [x, y, z] of CONTROL_POINT_DIRECTIONS) {
      assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-9);
    }
  });

  it('avoid the exact poles, where azimuth is undefined', () => {
    for (const [, y] of CONTROL_POINT_DIRECTIONS) {
      assert.ok(Math.abs(y) < 1, `a point sits on a pole (y=${y})`);
    }
  });

  it('are spread rather than clustered', () => {
    // No two points should coincide; the closest pair still has real separation.
    let closest = Infinity;
    for (let a = 0; a < CONTROL_POINT_COUNT; a += 1) {
      for (let b = a + 1; b < CONTROL_POINT_COUNT; b += 1) {
        const [ax, ay, az] = CONTROL_POINT_DIRECTIONS[a]!;
        const [bx, by, bz] = CONTROL_POINT_DIRECTIONS[b]!;
        closest = Math.min(closest, Math.hypot(ax - bx, ay - by, az - bz));
      }
    }
    assert.ok(closest > 0.3, `closest pair only ${closest.toFixed(3)} apart`);
  });
});

describe('sculptDisplacement', () => {
  it('is zero with no pulls', () => {
    const sculpt = emptySculpt();
    for (const [x, y, z] of CONTROL_POINT_DIRECTIONS) {
      assert.equal(sculptDisplacement(x, y, z, sculpt), 0);
    }
  });

  it('peaks at the pulled point', () => {
    const sculpt = emptySculpt();
    sculpt.pulls[0] = 1;

    const [x, y, z] = CONTROL_POINT_DIRECTIONS[0]!;
    const atPoint = sculptDisplacement(x, y, z, sculpt);

    assert.ok(atPoint > 0.3, `expected a strong outward pull, got ${atPoint}`);
  });

  it('falls to zero beyond its reach — this is what makes it local', () => {
    const sculpt = emptySculpt();
    sculpt.pulls[0] = 1;

    const [x, y, z] = CONTROL_POINT_DIRECTIONS[0]!;
    // The exact opposite side of the sphere is π away, far outside any reach.
    assert.equal(sculptDisplacement(-x, -y, -z, sculpt), 0);
  });

  it('decreases monotonically with angular distance', () => {
    const sculpt = emptySculpt();
    sculpt.pulls[0] = 1;

    const [x, y, z] = CONTROL_POINT_DIRECTIONS[0]!;
    const reach = influenceRadians(sculpt.influence);

    // Rotate away from the point in small steps, around an arbitrary axis.
    let previous = Infinity;
    for (let step = 0; step <= 8; step += 1) {
      const angle = (step / 8) * reach;
      // Build a direction `angle` away by blending with a perpendicular.
      const perpendicular = Math.abs(y) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      let px = y * perpendicular[2]! - z * perpendicular[1]!;
      let py = z * perpendicular[0]! - x * perpendicular[2]!;
      let pz = x * perpendicular[1]! - y * perpendicular[0]!;
      const length = Math.hypot(px, py, pz);
      px /= length;
      py /= length;
      pz /= length;

      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const value = sculptDisplacement(
        x * cos + px * sin,
        y * cos + py * sin,
        z * cos + pz * sin,
        sculpt,
      );

      assert.ok(value <= previous + 1e-9, `rose at step ${step}`);
      previous = value;
    }
  });

  it('pushes inward for a negative pull', () => {
    const sculpt = emptySculpt();
    sculpt.pulls[3] = -1;

    const [x, y, z] = CONTROL_POINT_DIRECTIONS[3]!;
    assert.ok(sculptDisplacement(x, y, z, sculpt) < -0.3);
  });

  it('accumulates where two pulls overlap', () => {
    const single = emptySculpt();
    single.pulls[0] = 0.5;

    const both = emptySculpt();
    both.pulls[0] = 0.5;
    both.pulls[1] = 0.5;
    both.influence = 1; // wide enough that the two overlap

    const [x, y, z] = CONTROL_POINT_DIRECTIONS[0]!;
    assert.ok(
      sculptDisplacement(x, y, z, both) > sculptDisplacement(x, y, z, single),
      'overlapping pulls should reinforce',
    );
  });

  it('reaches further at higher influence', () => {
    const narrow = { pulls: new Array(CONTROL_POINT_COUNT).fill(0), influence: 0 };
    const wide = { pulls: new Array(CONTROL_POINT_COUNT).fill(0), influence: 1 };
    narrow.pulls[0] = 1;
    wide.pulls[0] = 1;

    assert.ok(influenceRadians(1) > influenceRadians(0));

    // A direction just outside the narrow reach but inside the wide one.
    const [x, y, z] = CONTROL_POINT_DIRECTIONS[0]!;
    const angle = (influenceRadians(0) + influenceRadians(1)) / 2;
    const perpendicular = Math.abs(y) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let px = y * perpendicular[2]! - z * perpendicular[1]!;
    let py = z * perpendicular[0]! - x * perpendicular[2]!;
    let pz = x * perpendicular[1]! - y * perpendicular[0]!;
    const length = Math.hypot(px, py, pz);
    px /= length;
    py /= length;
    pz /= length;

    const probe: [number, number, number] = [
      x * Math.cos(angle) + px * Math.sin(angle),
      y * Math.cos(angle) + py * Math.sin(angle),
      z * Math.cos(angle) + pz * Math.sin(angle),
    ];

    assert.equal(sculptDisplacement(...probe, narrow), 0);
    assert.ok(sculptDisplacement(...probe, wide) > 0);
  });
});

describe('generated geometry', () => {
  it('changes shape when a point is pulled', () => {
    const plain = generateStone(base);

    const sculpt = emptySculpt();
    sculpt.pulls[0] = 1;
    const pulled = generateStone({ ...base, sculpt });

    let differs = false;
    for (let i = 0; i < plain.positions.length; i += 1) {
      if (Math.abs(plain.positions[i]! - pulled.positions[i]!) > 0.01) {
        differs = true;
        break;
      }
    }
    assert.ok(differs, 'pulling a control point must change the mesh');
  });

  it('still honours the requested bounding box exactly', () => {
    const sculpt = emptySculpt();
    sculpt.pulls[2] = 1;
    sculpt.pulls[7] = -1;

    const mesh = generateStone({
      ...base,
      sculpt,
      dimensions: { length_mm: 220, width_mm: 160, height_mm: 120 },
    });
    const box = boundingBox(mesh.positions);

    // The mesh is rescaled after sculpting, so the dimension fields stay true.
    assert.ok(Math.abs(box.length - 220) < 0.01, `length ${box.length}`);
    assert.ok(Math.abs(box.width - 160) < 0.01, `width ${box.width}`);
    assert.ok(Math.abs(box.height - 120) < 0.01, `height ${box.height}`);
  });

  it('is deterministic', () => {
    const sculpt = emptySculpt();
    sculpt.pulls[5] = 0.7;

    const first = generateStone({ ...base, sculpt });
    const second = generateStone({ ...base, sculpt: { ...sculpt, pulls: [...sculpt.pulls] } });

    assert.deepEqual(
      Array.from(first.positions.slice(0, 600)),
      Array.from(second.positions.slice(0, 600)),
    );
  });

  it('produces only finite values at extreme pulls', () => {
    const sculpt = { pulls: new Array(CONTROL_POINT_COUNT).fill(1), influence: 1 };
    const mesh = generateStone({ ...base, sculpt });

    for (const buffer of [mesh.positions, mesh.normals, mesh.colors]) {
      for (let i = 0; i < buffer.length; i += 1) {
        assert.ok(Number.isFinite(buffer[i]!), `non-finite at ${i}`);
      }
    }
  });

  it('survives every point pushed fully inward', () => {
    const sculpt = { pulls: new Array(CONTROL_POINT_COUNT).fill(-1), influence: 1 };
    const mesh = generateStone({ ...base, sculpt });

    // The generator floors the radius, so the stone cannot invert itself.
    const box = boundingBox(mesh.positions);
    assert.ok(box.length > 0 && box.width > 0 && box.height > 0);
  });
});

describe('sanitiseSculpt', () => {
  it('clamps out-of-range pulls', () => {
    const result = sanitiseSculpt({ pulls: [5, -9, Number.NaN], influence: 7 });
    assert.equal(result.pulls[0], 1);
    assert.equal(result.pulls[1], -1);
    assert.equal(result.pulls[2], 0);
    assert.ok(result.influence >= 0 && result.influence <= 1);
  });

  it('normalises the array length, so an older design still loads', () => {
    const short = sanitiseSculpt({ pulls: [0.5], influence: 0.5 });
    assert.equal(short.pulls.length, CONTROL_POINT_COUNT);
    assert.equal(short.pulls[0], 0.5);

    const long = sanitiseSculpt({ pulls: new Array(200).fill(0.5), influence: 0.5 });
    assert.equal(long.pulls.length, CONTROL_POINT_COUNT);
  });

  it('falls back cleanly on junk', () => {
    const result = sanitiseSculpt('not an object');
    assert.equal(result.pulls.length, CONTROL_POINT_COUNT);
    assert.ok(result.pulls.every((pull) => pull === 0));
  });

  it('reports whether anything has actually been sculpted', () => {
    assert.equal(isSculpted(emptySculpt()), false);
    const touched = emptySculpt();
    touched.pulls[1] = 0.4;
    assert.equal(isSculpted(touched), true);
  });
});

describe('share links', () => {
  it('carries the sculpt', () => {
    const sculpt = emptySculpt();
    sculpt.pulls[0] = 0.75;
    sculpt.pulls[6] = -0.5;
    sculpt.influence = 0.8;

    const decoded = decodeParams(encodeParams({ ...base, sculpt }, 'Sculpted'));

    assert.ok(decoded);
    assert.ok(Math.abs((decoded.params.sculpt?.pulls[0] ?? 0) - 0.75) < 0.01);
    assert.ok(Math.abs((decoded.params.sculpt?.pulls[6] ?? 0) + 0.5) < 0.01);
    assert.ok(Math.abs((decoded.params.sculpt?.influence ?? 0) - 0.8) < 0.01);
  });

  it('stays short when nothing is sculpted', () => {
    const plain = encodeParams({ ...base, sculpt: emptySculpt() }, 'Plain');
    const sculpted = emptySculpt();
    sculpted.pulls[0] = 1;
    const carved = encodeParams({ ...base, sculpt: sculpted }, 'Plain');

    // An untouched sculpt is omitted from the payload entirely.
    assert.ok(plain.length < carved.length, 'empty sculpt should add nothing');
    assert.ok(carved.length < 600, `sculpted link is ${carved.length} characters`);
  });
});
