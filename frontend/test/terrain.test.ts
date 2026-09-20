/**
 * Real ground, turned into a stone.
 *
 * The network half of this feature cannot be tested here, and does not need
 * to be: the interesting claim is not "a PNG was fetched" but "a mountain
 * makes a mountain-shaped stone and a plain makes a flat one". Every test
 * below builds a synthetic landscape whose answer is known by construction,
 * then checks the derivation agrees.
 *
 * The encoding and projection tests are the exception, and they are here
 * because both are the kind of arithmetic that is wrong in a way nothing
 * downstream reports — a stone derived from a point two hundred metres from
 * the pin is a perfectly plausible stone.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type TerrainSample,
  decodeTerrarium,
  groundResolution,
  heightAt,
  lngLatToPixel,
  summariseTerrain,
  zoomForSpan,
} from '../src/data/terrain';
import {
  characteriseTerrain,
  compassOf,
  convexityOf,
  deriveStoneFromTerrain,
  elongationOf,
  pullsFromTerrain,
  ruggednessOf,
} from '../src/features/studio/terrainStone';
import { temperToStone } from '../src/data/geo';
import { DEFAULT_PARAMS } from '../src/features/studio/types';
import { CONTROL_POINT_COUNT } from '../src/features/studio/controlPoints';
import { clampIntoLoop, pointInLoop } from '../src/features/studio/baseAndSupports';

const SIZE = 64;
const SPAN = 1800;

/** Build a sample from a function of position, with east and north in −1..1. */
function landscape(shape: (east: number, north: number) => number): TerrainSample {
  const heights = new Float32Array(SIZE * SIZE);
  const last = SIZE - 1;

  for (let row = 0; row < SIZE; row += 1) {
    for (let column = 0; column < SIZE; column += 1) {
      const east = (column / last) * 2 - 1;
      // Row 0 is north.
      const north = 1 - (row / last) * 2;
      heights[row * SIZE + column] = shape(east, north);
    }
  }

  const sample: TerrainSample = {
    latitude: 46,
    longitude: 8,
    spanMeters: SPAN,
    size: SIZE,
    metresPerSample: SPAN / last,
    heights,
    centreElevation: 0,
  };

  sample.centreElevation = heightAt(sample, 0, 0);
  return sample;
}

const PLAIN = landscape(() => 120);
const CONE = landscape((e, n) => 1400 - 900 * Math.hypot(e, n));
const BASIN = landscape((e, n) => 400 + 700 * Math.hypot(e, n));
/** A ridge running north–south: elevation varies with east only. */
const RIDGE = landscape((e) => 800 - 500 * Math.abs(e));
/** An even slope falling toward the east. */
const SLOPE = landscape((e) => 600 - 300 * e);
const SCREE = landscape(
  (e, n) => 900 - 400 * Math.hypot(e, n) + 60 * Math.sin(e * 41) * Math.cos(n * 37),
);

describe('terrarium decoding', () => {
  it('reads sea level at the encoding origin', () => {
    // 32768 = 128 * 256, so a mid-grey red channel is zero metres.
    assert.equal(decodeTerrarium(128, 0, 0), 0);
  });

  it('reads heights and depths either side of it', () => {
    assert.equal(decodeTerrarium(162, 84, 0), 162 * 256 + 84 - 32768);
    assert.ok(decodeTerrarium(126, 0, 0) < 0, 'below the origin is below sea level');
  });

  it('resolves the blue channel to fractions of a metre', () => {
    assert.ok(Math.abs(decodeTerrarium(128, 0, 128) - 0.5) < 1e-9);
  });
});

describe('web mercator', () => {
  it('puts the prime meridian and the equator at the centre of the world', () => {
    const { x, y } = lngLatToPixel(0, 0, 0);
    assert.ok(Math.abs(x - 128) < 1e-6);
    assert.ok(Math.abs(y - 128) < 1e-6);
  });

  it('maps the antimeridian to each edge', () => {
    assert.ok(Math.abs(lngLatToPixel(-180, 0, 0).x) < 1e-6);
    assert.ok(Math.abs(lngLatToPixel(180, 0, 0).x - 256) < 1e-6);
  });

  it('is fractional, so the window is not shifted to a tile grid', () => {
    const { x } = lngLatToPixel(8.0001, 46, 14);
    assert.notEqual(x, Math.round(x));
  });

  it('shrinks ground resolution with latitude and with zoom', () => {
    assert.ok(groundResolution(60, 12) < groundResolution(0, 12));
    assert.ok(Math.abs(groundResolution(0, 13) * 2 - groundResolution(0, 12)) < 1e-6);
  });

  it('chooses a zoom whose pixels are near the sample spacing', () => {
    const zoom = zoomForSpan(46, SPAN, 96);
    const resolution = groundResolution(46, zoom);
    const wanted = SPAN / 96;

    // Within a factor of two, which is the most a whole zoom step can miss by.
    assert.ok(resolution > wanted / 2 && resolution < wanted * 2);
  });

  it('stays inside the tile set even for an absurd request', () => {
    assert.ok(zoomForSpan(0, 1, 96) <= 14, 'no deeper than the data goes');
    assert.ok(zoomForSpan(0, 5_000_000, 96) >= 8, 'no shallower than useful');
  });
});

describe('sampling the grid', () => {
  it('reads the corners as the corners', () => {
    const sample = landscape((e, n) => e * 100 + n * 10);

    assert.ok(Math.abs(heightAt(sample, -1, 1) - -90) < 1e-3, 'north-west');
    assert.ok(Math.abs(heightAt(sample, 1, 1) - 110) < 1e-3, 'north-east');
    assert.ok(Math.abs(heightAt(sample, 1, -1) - 90) < 1e-3, 'south-east');
  });

  it('interpolates between samples rather than snapping to one', () => {
    const sample = landscape((e) => e * 100);
    const between = heightAt(sample, 0.5, 0);
    assert.ok(Math.abs(between - 50) < 2);
  });
});

describe('summarising a landscape', () => {
  it('reports no relief on flat ground, and says so', () => {
    const summary = summariseTerrain(PLAIN);

    assert.equal(summary.relief, 0);
    assert.equal(summary.meanElevation, 120);
    assert.ok(summary.flat);
    assert.ok(summary.slopeDegrees < 0.01);
  });

  it('measures relief and slope on a cone', () => {
    const summary = summariseTerrain(CONE);

    assert.ok(!summary.flat);
    // 900 m over the full half-diagonal, so the corners are the low point.
    assert.ok(summary.relief > 700, `relief was ${summary.relief}`);
    assert.ok(summary.slopeDegrees > 20, `slope was ${summary.slopeDegrees}`);
  });

  it('tells broken ground from smooth ground of the same height', () => {
    // Both are cones of the same size; only one is shattered.
    const smooth = summariseTerrain(CONE);
    const broken = summariseTerrain(SCREE);

    assert.ok(
      broken.roughness > smooth.roughness * 3,
      `scree ${broken.roughness} vs cone ${smooth.roughness}`,
    );
  });

  it('finds the downhill direction of an even slope', () => {
    // Elevation falls as east increases, so the ground falls toward the east.
    const summary = summariseTerrain(SLOPE);
    assert.equal(compassOf(summary.aspectDegrees), 'east');
  });

  it('reports no aspect where there is no slope worth naming', () => {
    assert.equal(summariseTerrain(PLAIN).aspectDegrees, 0);
  });
});

describe('reading the shape of the land', () => {
  it('scores a mountain as rugged and a plain as not', () => {
    assert.ok(ruggednessOf(summariseTerrain(CONE), CONE) > 0.8);
    assert.equal(ruggednessOf(summariseTerrain(PLAIN), PLAIN), 0);
  });

  it('tells a ridge from a dome', () => {
    const ridge = elongationOf(RIDGE, summariseTerrain(RIDGE));
    const dome = elongationOf(CONE, summariseTerrain(CONE));

    assert.ok(ridge < dome, `ridge ${ridge} should be more linear than cone ${dome}`);
    assert.ok(ridge < 0.6, 'a ridge is clearly linear');
    assert.ok(dome > 0.85, 'a cone is clearly round');
  });

  it('tells a summit from a basin by sign', () => {
    assert.ok(convexityOf(CONE, summariseTerrain(CONE)) > 0.5, 'a peak is convex');
    assert.ok(convexityOf(BASIN, summariseTerrain(BASIN)) < -0.5, 'a basin is concave');
  });

  it('names places recognisably', () => {
    assert.equal(characteriseTerrain(summariseTerrain(PLAIN), 0), 'Flat ground');
    assert.match(characteriseTerrain(summariseTerrain(CONE), 0.9), /^Alpine/);
  });
});

describe('terrain as control points', () => {
  it('produces one pull per handle, all in range', () => {
    const pulls = pullsFromTerrain(CONE, summariseTerrain(CONE));

    assert.equal(pulls.length, CONTROL_POINT_COUNT);
    for (const pull of pulls) {
      assert.ok(Number.isFinite(pull), 'no NaN reaches the generator');
      assert.ok(pull >= -1 && pull <= 1, `pull ${pull} is out of range`);
    }
  });

  it('leaves flat ground unsculpted rather than dividing by zero', () => {
    const pulls = pullsFromTerrain(PLAIN, summariseTerrain(PLAIN));
    for (const pull of pulls) assert.equal(pull, 0);
  });

  it('fades to nothing at the bottom, so the stone keeps a face to print on', () => {
    const pulls = pullsFromTerrain(SCREE, summariseTerrain(SCREE));

    // Handle 13 of 14 is the lowest on the Fibonacci sphere.
    const lowest = Math.abs(pulls[CONTROL_POINT_COUNT - 1]!);
    const strongest = pulls.reduce((peak, pull) => Math.max(peak, Math.abs(pull)), 0);

    assert.ok(lowest < strongest * 0.2, `underside pull ${lowest} against peak ${strongest}`);
  });

  it('shapes the stone strongly enough to see', () => {
    const pulls = pullsFromTerrain(RIDGE, summariseTerrain(RIDGE));
    const strongest = pulls.reduce((peak, pull) => Math.max(peak, Math.abs(pull)), 0);

    assert.ok(strongest > 0.3, `strongest pull was only ${strongest}`);
  });
});

describe('deriving a stone from a place', () => {
  const deriveFrom = (sample: TerrainSample) =>
    deriveStoneFromTerrain(DEFAULT_PARAMS, sample, summariseTerrain(sample), null);

  it('keeps the length the user chose', () => {
    for (const sample of [PLAIN, CONE, RIDGE, SCREE]) {
      assert.equal(
        deriveFrom(sample).params.dimensions.length_mm,
        DEFAULT_PARAMS.dimensions.length_mm,
        'the ground decides the shape, not the print size',
      );
    }
  });

  it('makes a mountain tall and a plain flat', () => {
    const mountain = deriveFrom(CONE).params;
    const plain = deriveFrom(PLAIN).params;

    assert.ok(
      mountain.dimensions.height_mm > plain.dimensions.height_mm * 1.8,
      `${mountain.dimensions.height_mm} mm against ${plain.dimensions.height_mm} mm`,
    );
    assert.ok(plain.form.flatten > 0.6, 'flat country gives a flat stone');
    assert.ok(mountain.form.flatten < 0.2, 'a peak does not');
  });

  it('narrows a stone taken from a ridge', () => {
    assert.ok(deriveFrom(RIDGE).params.dimensions.width_mm < deriveFrom(CONE).params.dimensions.width_mm);
  });

  it('gives broken ground a coarse surface and smooth ground a worn one', () => {
    const scree = deriveFrom(SCREE).params.surface;
    const cone = deriveFrom(CONE).params.surface;

    assert.ok(scree.detail > cone.detail);
    assert.ok(scree.grain > cone.grain);
    assert.ok(scree.erosion < cone.erosion, 'what is still broken has not worn');
  });

  it('bulges on a summit and pinches in a basin', () => {
    assert.ok(deriveFrom(CONE).params.form.bulge > deriveFrom(BASIN).params.form.bulge);
  });

  it('stays inside every parameter limit, for any landscape', () => {
    for (const sample of [PLAIN, CONE, BASIN, RIDGE, SLOPE, SCREE]) {
      const { form, surface, dimensions } = deriveFrom(sample).params;

      for (const [name, value] of Object.entries(form)) {
        const floor = name === 'taper' ? -1 : 0;
        assert.ok(value >= floor && value <= 1, `form.${name} was ${value}`);
      }
      for (const [name, value] of Object.entries(surface)) {
        if (name === 'resolution') continue;
        assert.ok(value >= 0 && value <= 1, `surface.${name} was ${value}`);
      }
      for (const [name, value] of Object.entries(dimensions)) {
        assert.ok(value >= 1 && Number.isFinite(value), `dimensions.${name} was ${value}`);
      }
    }
  });

  it('keeps the material when no imagery came back', () => {
    assert.deepEqual(deriveFrom(CONE).params.material, DEFAULT_PARAMS.material);
  });

  it('takes the colour from imagery when it did', () => {
    const derived = deriveStoneFromTerrain(
      DEFAULT_PARAMS,
      CONE,
      summariseTerrain(CONE),
      { color: '#7a6d5a', accentColor: '#40382c' },
    );

    assert.equal(derived.params.material.color, '#7a6d5a');
    // Everything the imagery has no opinion about survives.
    assert.equal(derived.params.material.roughness, DEFAULT_PARAMS.material.roughness);
  });

  it('explains itself, so the panel has something true to show', () => {
    const derived = deriveFrom(CONE);
    assert.ok(derived.notes.length >= 3);
    for (const note of derived.notes) assert.ok(note.length > 10);
  });
});

describe('imagery colour', () => {
  it('leaves grey alone — there is no saturation to pull back', () => {
    const [r, g, b] = temperToStone(90, 90, 90);
    assert.ok(Math.abs(r - 90) < 1e-6 && Math.abs(g - 90) < 1e-6 && Math.abs(b - 90) < 1e-6);
  });

  it('mutes vivid canopy without turning it grey or dark', () => {
    const [r, g, b] = temperToStone(40, 190, 50);

    assert.ok(g > r && g > b, 'the hue survives');
    assert.ok(g - r < 150 - 0, 'but not at full strength');
    assert.ok(g < 190, 'the green is pulled in');
    // Luma is preserved exactly, so a bright place stays bright.
    const before = 0.2126 * 40 + 0.7152 * 190 + 0.0722 * 50;
    const after = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    assert.ok(Math.abs(before - after) < 1e-6);
  });
});

describe('keeping a support inside the cavity', () => {
  const square: { x: number; z: number }[] = [
    { x: -50, z: -50 },
    { x: 50, z: -50 },
    { x: 50, z: 50 },
    { x: -50, z: 50 },
  ];

  it('leaves a post that is already well inside where it is', () => {
    const clamped = clampIntoLoop(square, 10, -20, 4);
    assert.deepEqual(clamped, { x: 10, z: -20 });
  });

  it('pulls a post that has escaped back inside', () => {
    const clamped = clampIntoLoop(square, 120, 0, 4);

    assert.ok(pointInLoop(square, clamped.x, clamped.z), 'back inside the cavity');
    assert.ok(Math.abs(clamped.x - 46) < 1e-6, 'held one inset clear of the wall');
    assert.equal(clamped.z, 0, 'and no further from the pointer than it has to be');
  });

  it('holds a post clear of the wall it is standing against', () => {
    // Inside, but with only 1 mm of floor under half a 12 mm post.
    const clamped = clampIntoLoop(square, 49, 0, 6);
    assert.ok(clamped.x <= 44 + 1e-6, `left at x=${clamped.x}, too close to the wall`);
  });

  it('slides along the boundary rather than sticking at one point', () => {
    // Two different escapes past the same wall must not collapse together;
    // sticking is what makes a clamped drag feel broken.
    const low = clampIntoLoop(square, 90, -30, 4);
    const high = clampIntoLoop(square, 90, 30, 4);

    assert.notEqual(low.z, high.z);
    assert.ok(low.z < high.z);
  });

  it('handles a post exactly on the wall without producing NaN', () => {
    const clamped = clampIntoLoop(square, 50, 0, 4);

    assert.ok(Number.isFinite(clamped.x) && Number.isFinite(clamped.z));
    assert.ok(pointInLoop(square, clamped.x, clamped.z));
  });

  it('gives up gracefully when there is no loop to stay inside', () => {
    assert.deepEqual(clampIntoLoop([], 10, 10, 4), { x: 10, z: 10 });
  });
});
