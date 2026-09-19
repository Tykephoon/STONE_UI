/**
 * Generator guarantees.
 *
 * Three properties the rest of the studio depends on and that are easy to break
 * with an innocuous-looking change to the noise pipeline:
 *
 *   - the realised bounding box equals the requested dimensions exactly,
 *     because the dimension inputs would otherwise be decorative;
 *   - the same seed yields byte-identical geometry, because share links carry
 *     parameters rather than meshes;
 *   - hostile or extreme parameters produce a finite, well-formed mesh.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateStone, type StoneParams } from '../src/features/studio/generator/stone';
import { DEFAULT_PARAMS, sanitiseParams, seedFromCoordinates } from '../src/features/studio/types';
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

describe('dimensions', () => {
  it('realises the requested bounding box exactly', () => {
    const mesh = generateStone({
      ...base,
      dimensions: { length_mm: 220, width_mm: 160, height_mm: 120 },
    });
    const box = boundingBox(mesh.positions);

    assert.ok(Math.abs(box.length - 220) < 0.01, `length ${box.length}`);
    assert.ok(Math.abs(box.width - 160) < 0.01, `width ${box.width}`);
    assert.ok(Math.abs(box.height - 120) < 0.01, `height ${box.height}`);
  });

  it('honours extreme aspect ratios', () => {
    const mesh = generateStone({
      ...base,
      form: { roundness: 0, taper: -1, asymmetry: 1, flatten: 1, bulge: 1 },
      surface: { detail: 1, grain: 1, erosion: 1, faceting: 1, resolution: 3 },
      dimensions: { length_mm: 1, width_mm: 10_000, height_mm: 1 },
    });
    const box = boundingBox(mesh.positions);

    assert.ok(Math.abs(box.length - 1) < 0.01);
    assert.ok(Math.abs(box.width - 10_000) < 0.5);
    assert.ok(Math.abs(box.height - 1) < 0.01);
  });
});

describe('determinism', () => {
  it('reproduces identical geometry for the same seed', () => {
    const first = generateStone(base);
    const second = generateStone(base);

    assert.equal(first.positions.length, second.positions.length);
    assert.deepEqual(Array.from(first.positions.slice(0, 600)), Array.from(second.positions.slice(0, 600)));
  });

  it('produces a different stone for different coordinates', () => {
    const boston = generateStone({ ...base, seed: seedFromCoordinates(42.3398, -71.0892) });
    const london = generateStone({ ...base, seed: seedFromCoordinates(51.5072, -0.1276) });

    const differs = Array.from(boston.positions.slice(0, 3000)).some(
      (value, index) => Math.abs(value - london.positions[index]!) > 1e-4,
    );
    assert.ok(differs, 'two locations must not yield the same mesh');
  });

  it('keeps the same seed for a sub-metre pin nudge', () => {
    assert.equal(
      seedFromCoordinates(42.3398012, -71.0892008),
      seedFromCoordinates(42.339801, -71.089201),
    );
  });
});

describe('output integrity', () => {
  it('emits the expected triangle count for the subdivision level', () => {
    for (const resolution of [2, 3, 4, 5]) {
      const mesh = generateStone({ ...base, surface: { ...base.surface, resolution } });
      assert.equal(mesh.triangleCount, 20 * 4 ** resolution);
    }
  });

  it('emits only finite values', () => {
    const mesh = generateStone(base);
    for (const buffer of [mesh.positions, mesh.normals, mesh.colors]) {
      for (let i = 0; i < buffer.length; i += 1) {
        assert.ok(Number.isFinite(buffer[i]!), `non-finite at ${i}`);
      }
    }
  });

  it('emits unit-length normals', () => {
    const mesh = generateStone(base);
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const length = Math.hypot(mesh.normals[i]!, mesh.normals[i + 1]!, mesh.normals[i + 2]!);
      assert.ok(Math.abs(length - 1) < 1e-3, `normal length ${length}`);
    }
  });

  it('keeps vertex colours inside the unit range', () => {
    const mesh = generateStone({ ...base, material: { ...base.material, speckle: 1 } });
    for (let i = 0; i < mesh.colors.length; i += 1) {
      const value = mesh.colors[i]!;
      assert.ok(value >= 0 && value <= 1, `colour ${value} out of range`);
    }
  });
});

describe('untrusted parameters', () => {
  it('clamps values that would otherwise break the generator', () => {
    const sanitised = sanitiseParams({
      seed: 'x'.repeat(500),
      dimensions: { length_mm: -50, width_mm: 1e9, height_mm: Number.NaN },
      form: { roundness: 5, taper: -9, asymmetry: -1, flatten: 2, bulge: Number.POSITIVE_INFINITY },
      surface: { detail: 2, grain: -1, erosion: 9, faceting: 3, resolution: 99 },
      material: {
        color: 'javascript:alert(1)',
        accentColor: '#zzzzzz',
        roughness: 7,
        metalness: -2,
        speckle: 4,
        clearcoat: 8,
      },
    });

    assert.equal(sanitised.surface.resolution, 6, 'resolution is capped');
    assert.ok(sanitised.dimensions.length_mm >= 1);
    assert.ok(sanitised.dimensions.width_mm <= 10_000);
    assert.ok(sanitised.form.roundness <= 1 && sanitised.form.roundness >= 0);
    assert.match(sanitised.material.color, /^#[0-9a-fA-F]{6}$/, 'invalid colour falls back');
    assert.match(sanitised.material.accentColor, /^#[0-9a-fA-F]{6}$/);

    // And the clamped result still generates.
    const mesh = generateStone(sanitised);
    assert.ok(mesh.triangleCount > 0);
  });

  it('returns null for a malformed share payload rather than throwing', () => {
    assert.equal(decodeParams('not-base64!!'), null);
    assert.equal(decodeParams(''), null);
    assert.equal(decodeParams(btoa('{"v":99}')), null);
  });
});

describe('parameter links', () => {
  it('round-trips through encoding', () => {
    const encoded = encodeParams(base, 'Test stone');
    const decoded = decodeParams(encoded);

    assert.ok(decoded);
    assert.equal(decoded.name, 'Test stone');
    assert.equal(decoded.params.seed, base.seed);
    assert.equal(decoded.params.dimensions.length_mm, base.dimensions.length_mm);
    assert.equal(decoded.params.surface.resolution, base.surface.resolution);
    assert.equal(decoded.params.material.color, base.material.color);
  });

  it('stays short enough to paste into a chat message', () => {
    const encoded = encodeParams(base, 'A reasonably descriptive stone name');
    assert.ok(encoded.length < 500, `encoded length ${encoded.length}`);
  });
});
