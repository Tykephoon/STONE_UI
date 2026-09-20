/**
 * Reading a rock out of a photograph.
 *
 * Every image here is synthesised so its answer is known before the analysis
 * runs: an ellipse of a stated size on a stated background, noise of a stated
 * amplitude, stripes at a stated angle. That is the only way to assert this
 * kind of code is right — "it looked plausible on my holiday photo" is not a
 * test, and a measurement that is silently wrong still produces a perfectly
 * convincing rock.
 *
 * The browser half — decoding a file, seeking a video, cropping to a canvas —
 * is not covered here and does not need to be. It is glue around APIs the
 * browser owns; everything that decides what a stone looks like is below.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type PixelGrid,
  analyseRock,
  characteriseRock,
  describeSilhouette,
  deriveStoneFromImage,
  downsample,
  measureColour,
  measureSurface,
  pullsFromSilhouette,
  segmentSubject,
} from '../src/features/studio/rockAnalysis';
import { DEFAULT_PARAMS } from '../src/features/studio/types';
import { CONTROL_POINT_COUNT } from '../src/features/studio/controlPoints';

const WIDTH = 160;
const HEIGHT = 160;

/**
 * Deterministic noise.
 *
 * `Math.random` would make a failure unreproducible, which for a statistical
 * measurement is the difference between a bug and a rumour.
 */
function makeNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0xffffffff;
  };
}

interface Paint {
  /** Background colour. */
  background: [number, number, number];
  /** Rock colour. */
  rock: [number, number, number];
  /** Ellipse semi-axes as a fraction of the image. */
  radiusX?: number;
  radiusY?: number;
  /** Peak noise added to the rock, in levels. */
  rockNoise?: number;
  /** Peak noise added to the background. */
  backgroundNoise?: number;
  /** Amplitude of straight diagonal banding across the rock. */
  stripes?: number;
  /** Fraction of the rock given a bright specular patch. */
  highlight?: number;
  seed?: number;
}

/** An ellipse on a background, with optional texture. */
function paintRock(options: Paint, width = WIDTH, height = HEIGHT): PixelGrid {
  const {
    background,
    rock,
    radiusX = 0.34,
    radiusY = 0.34,
    rockNoise = 0,
    backgroundNoise = 2,
    stripes = 0,
    highlight = 0,
    seed = 7,
  } = options;

  const random = makeNoise(seed);
  const data = new Uint8ClampedArray(width * height * 4);

  const cx = width / 2;
  const cy = height / 2;
  const rx = width * radiusX;
  const ry = height * radiusY;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const isRock = nx * nx + ny * ny <= 1;

      const base = isRock ? rock : background;
      const jitter = ((random() * 2 - 1) * (isRock ? rockNoise : backgroundNoise));
      // A straight diagonal band: constant along one direction, which is
      // exactly what a flat fractured face looks like to a gradient.
      const band = isRock && stripes > 0 ? Math.sin((x + y) * 0.7) * stripes : 0;
      const glare =
        isRock && highlight > 0 && nx * nx + ny * ny < highlight * highlight ? 90 : 0;

      const index = (y * width + x) * 4;
      data[index] = base[0] + jitter + band + glare;
      data[index + 1] = base[1] + jitter + band + glare;
      data[index + 2] = base[2] + jitter + band + glare;
      data[index + 3] = 255;
    }
  }

  return { data, width, height };
}

/** A flat field of one colour — no subject at all. */
function paintFlat(colour: [number, number, number], width = WIDTH, height = HEIGHT): PixelGrid {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = colour[0];
    data[i * 4 + 1] = colour[1];
    data[i * 4 + 2] = colour[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

const GRASS: [number, number, number] = [60, 110, 55];
const GREY_ROCK: [number, number, number] = [150, 146, 138];

describe('downsampling', () => {
  it('leaves an image that is already small enough alone', () => {
    const image = paintFlat([10, 20, 30], 40, 30);
    assert.equal(downsample(image, 384), image);
  });

  it('shrinks the longest edge and keeps the proportions', () => {
    const small = downsample(paintFlat([10, 20, 30], 800, 400), 100);
    assert.equal(small.width, 100);
    assert.equal(small.height, 50);
  });

  it('averages rather than samples, so colour survives', () => {
    const small = downsample(paintFlat([120, 60, 30], 400, 400), 40);
    const index = (20 * 40 + 20) * 4;
    assert.ok(Math.abs(small.data[index]! - 120) < 2);
    assert.ok(Math.abs(small.data[index + 1]! - 60) < 2);
  });
});

describe('separating the rock from the ground', () => {
  it('finds a rock that contrasts with what it sits on', () => {
    const mask = segmentSubject(paintRock({ background: GRASS, rock: GREY_ROCK }));

    // An ellipse of 0.34 semi-axes covers pi * 0.34^2 ~= 36% of the frame.
    const coverage = mask.area / (WIDTH * HEIGHT);
    assert.ok(coverage > 0.3 && coverage < 0.42, `coverage was ${coverage}`);
  });

  it('puts the mask where the rock actually is', () => {
    const mask = segmentSubject(paintRock({ background: GRASS, rock: GREY_ROCK }));
    const at = (x: number, y: number) => mask.data[y * WIDTH + x];

    assert.equal(at(80, 80), 1, 'the middle is rock');
    assert.equal(at(4, 4), 0, 'the corner is not');
  });

  it('finds nothing in a flat field, rather than inventing a subject', () => {
    assert.equal(segmentSubject(paintFlat([90, 90, 90])).area, 0);
  });

  it('is not fooled by a noisy background', () => {
    const mask = segmentSubject(
      paintRock({ background: GRASS, rock: GREY_ROCK, backgroundNoise: 18 }),
    );
    const coverage = mask.area / (WIDTH * HEIGHT);
    assert.ok(coverage > 0.25 && coverage < 0.55, `coverage was ${coverage}`);
  });

  it('ignores a bigger blob off-centre in favour of the one in the middle', () => {
    const image = paintRock({ background: GRASS, rock: GREY_ROCK, radiusX: 0.12, radiusY: 0.12 });
    // A bright square with more area than the central rock, clear of the
    // border band — which is background by definition and must stay that way.
    for (let y = 16; y < 60; y += 1) {
      for (let x = 16; x < 60; x += 1) {
        const index = (y * WIDTH + x) * 4;
        image.data[index] = 230;
        image.data[index + 1] = 40;
        image.data[index + 2] = 230;
      }
    }

    const mask = segmentSubject(image);
    assert.equal(mask.data[80 * WIDTH + 80], 1, 'kept the central rock');
    assert.equal(mask.data[38 * WIDTH + 38], 0, 'discarded the larger off-centre blob');
  });
});

describe('the outline', () => {
  it('measures a circle as square-on and mostly filled', () => {
    const shape = describeSilhouette(segmentSubject(paintRock({ background: GRASS, rock: GREY_ROCK })));
    assert.ok(shape);

    assert.ok(Math.abs(shape.widthOverHeight - 1) < 0.08, `ratio ${shape.widthOverHeight}`);
    // An ellipse fills pi/4 ~= 0.785 of its bounding box.
    assert.ok(Math.abs(shape.fillRatio - 0.785) < 0.06, `fill ${shape.fillRatio}`);
    assert.ok(shape.convexity > 0.95, 'an ellipse is convex');
  });

  it('measures a wide rock as wide and a tall one as tall', () => {
    const wide = describeSilhouette(
      segmentSubject(paintRock({ background: GRASS, rock: GREY_ROCK, radiusX: 0.45, radiusY: 0.2 })),
    );
    const tall = describeSilhouette(
      segmentSubject(paintRock({ background: GRASS, rock: GREY_ROCK, radiusX: 0.2, radiusY: 0.45 })),
    );

    assert.ok(wide && tall);
    assert.ok(wide.widthOverHeight > 2, `wide was ${wide.widthOverHeight}`);
    assert.ok(tall.widthOverHeight < 0.5, `tall was ${tall.widthOverHeight}`);
  });

  it('keeps a constant radius round a circle', () => {
    const shape = describeSilhouette(segmentSubject(paintRock({ background: GRASS, rock: GREY_ROCK })));
    assert.ok(shape);

    for (const radius of shape.profile) {
      assert.ok(
        Math.abs(radius - shape.meanRadius) < shape.meanRadius * 0.1,
        `radius ${radius} against mean ${shape.meanRadius}`,
      );
    }
  });

  it('refuses when the box was drawn inside the rock', () => {
    // Every pixel is rock, so the edge of the box is the only outline there
    // is, and it is the user's rectangle rather than the stone's shape.
    const image = paintRock({ background: GREY_ROCK, rock: GREY_ROCK });
    assert.equal(describeSilhouette(segmentSubject(image)), null);
  });

  it('refuses when there is barely anything there', () => {
    const tiny = segmentSubject(
      paintRock({ background: GRASS, rock: GREY_ROCK, radiusX: 0.03, radiusY: 0.03 }),
    );
    assert.equal(describeSilhouette(tiny), null);
  });
});

describe('the surface', () => {
  const surfaceOf = (options: Paint) => {
    const image = paintRock(options);
    return measureSurface(image, segmentSubject(image));
  };

  it('reads a smooth rock as smooth', () => {
    const surface = surfaceOf({ background: GRASS, rock: GREY_ROCK });
    assert.ok(surface.roughness < 0.12, `roughness ${surface.roughness}`);
  });

  it('reads a noisy rock as rough', () => {
    const surface = surfaceOf({ background: GRASS, rock: GREY_ROCK, rockNoise: 55 });
    assert.ok(surface.roughness > 0.5, `roughness ${surface.roughness}`);
  });

  it('does not count the rock-against-grass edge as texture', () => {
    // If the outline leaked into the measurement, a perfectly smooth rock on
    // a strongly contrasting background would read as rough.
    const image = paintRock({ background: [10, 200, 10], rock: [200, 10, 10] });
    const masked = measureSurface(image, segmentSubject(image));
    const unmasked = measureSurface(image, null);

    assert.ok(masked.roughness < 0.1, `masked roughness ${masked.roughness}`);
    assert.ok(unmasked.roughness > masked.roughness, 'the edge does show up unmasked');
  });

  it('tells straight banding from isotropic noise', () => {
    // The point of windowing the structure tensor: a single pixel's tensor is
    // rank one and scores 1 for any input at all, so without a neighbourhood
    // these two would be indistinguishable.
    const faceted = surfaceOf({ background: GRASS, rock: GREY_ROCK, stripes: 40 });
    const pitted = surfaceOf({ background: GRASS, rock: GREY_ROCK, rockNoise: 55 });

    assert.ok(
      faceted.faceting > pitted.faceting + 0.25,
      `banded ${faceted.faceting} against noisy ${pitted.faceting}`,
    );
    assert.ok(faceted.faceting > 0.5, 'straight edges read as flat faces');
  });

  it('reports no sheen on a matte rock and some on a glinting one', () => {
    const matte = surfaceOf({ background: GRASS, rock: GREY_ROCK });
    const glint = surfaceOf({ background: GRASS, rock: GREY_ROCK, highlight: 0.3 });

    assert.ok(glint.gloss > matte.gloss, `${glint.gloss} against ${matte.gloss}`);
  });

  it('keeps every statistic inside its range, on any input', () => {
    const cases: Paint[] = [
      { background: GRASS, rock: GREY_ROCK },
      { background: GRASS, rock: GREY_ROCK, rockNoise: 120 },
      { background: GRASS, rock: GREY_ROCK, stripes: 90, rockNoise: 40 },
      { background: [0, 0, 0], rock: [255, 255, 255], highlight: 0.8 },
    ];

    for (const options of cases) {
      const surface = surfaceOf(options);
      for (const [name, value] of Object.entries(surface)) {
        assert.ok(value >= 0 && value <= 1, `${name} was ${value}`);
        assert.ok(Number.isFinite(value), `${name} was not finite`);
      }
    }
  });

  it('does not divide by zero when the mask is empty', () => {
    const image = paintFlat([90, 90, 90]);
    const surface = measureSurface(image, segmentSubject(image));
    for (const value of Object.values(surface)) assert.ok(Number.isFinite(value));
  });
});

describe('colour', () => {
  it('takes the rock’s colour, not the background’s', () => {
    const image = paintRock({ background: [20, 200, 20], rock: [170, 120, 80] });
    const colour = measureColour(image, segmentSubject(image));

    assert.equal(colour.color, '#aa7850');
  });

  it('gives the crevices a darker companion', () => {
    const image = paintRock({ background: GRASS, rock: [170, 120, 80], rockNoise: 40 });
    const colour = measureColour(image, segmentSubject(image));

    const value = (hex: string) => Number.parseInt(hex.slice(1, 3), 16);
    assert.ok(value(colour.accentColor) < value(colour.color), 'accent is darker than base');
  });

  it('falls back rather than throwing when nothing was found', () => {
    const flat = paintFlat([90, 90, 90]);
    const colour = measureColour(flat, segmentSubject(flat));
    // No mask means the whole selection is the sample, not an empty average.
    assert.equal(colour.color, '#5a5a5a');
  });
});

describe('the outline as control points', () => {
  const circle = describeSilhouette(
    segmentSubject(paintRock({ background: GRASS, rock: GREY_ROCK })),
  )!;

  it('produces one pull per handle, all in range', () => {
    const pulls = pullsFromSilhouette(circle);

    assert.equal(pulls.length, CONTROL_POINT_COUNT);
    for (const pull of pulls) {
      assert.ok(Number.isFinite(pull) && pull >= -1 && pull <= 1, `pull ${pull}`);
    }
  });

  it('barely shapes a circle, which has nothing to say', () => {
    const strongest = pullsFromSilhouette(circle).reduce((p, v) => Math.max(p, Math.abs(v)), 0);
    assert.ok(strongest < 0.35, `a round outline should be quiet, got ${strongest}`);
  });

  it('shapes a lopsided outline strongly', () => {
    const lopsided = { ...circle, profile: circle.profile.map((r, i) => (i < 12 ? r * 1.9 : r * 0.6)) };
    lopsided.meanRadius =
      lopsided.profile.reduce((t, r) => t + r, 0) / lopsided.profile.length;

    const strongest = pullsFromSilhouette(lopsided).reduce((p, v) => Math.max(p, Math.abs(v)), 0);
    assert.ok(strongest > 0.5, `expected clear shaping, got ${strongest}`);
  });

  it('fades to nothing at the bottom, so the stone keeps a face to print on', () => {
    const lopsided = { ...circle, profile: circle.profile.map((r, i) => (i < 12 ? r * 1.9 : r * 0.6)) };
    lopsided.meanRadius =
      lopsided.profile.reduce((t, r) => t + r, 0) / lopsided.profile.length;

    const pulls = pullsFromSilhouette(lopsided);
    const lowest = Math.abs(pulls[CONTROL_POINT_COUNT - 1]!);
    const strongest = pulls.reduce((p, v) => Math.max(p, Math.abs(v)), 0);

    assert.ok(lowest < strongest * 0.25, `underside ${lowest} against peak ${strongest}`);
  });
});

describe('deriving a stone from a photograph', () => {
  const deriveFrom = (options: Paint) =>
    deriveStoneFromImage(DEFAULT_PARAMS, analyseRock(paintRock(options)));

  it('keeps the length the user chose', () => {
    for (const options of [
      { background: GRASS, rock: GREY_ROCK },
      { background: GRASS, rock: GREY_ROCK, radiusX: 0.45, radiusY: 0.18 },
      { background: GRASS, rock: GREY_ROCK, rockNoise: 90 },
    ] satisfies Paint[]) {
      assert.equal(
        deriveFrom(options).params.dimensions.length_mm,
        DEFAULT_PARAMS.dimensions.length_mm,
        'the photo decides the shape, not the print size',
      );
    }
  });

  it('makes a wide rock flat and a tall rock tall', () => {
    const wide = deriveFrom({ background: GRASS, rock: GREY_ROCK, radiusX: 0.45, radiusY: 0.18 });
    const tall = deriveFrom({ background: GRASS, rock: GREY_ROCK, radiusX: 0.18, radiusY: 0.45 });

    assert.ok(
      tall.params.dimensions.height_mm > wide.params.dimensions.height_mm * 1.5,
      `${tall.params.dimensions.height_mm} against ${wide.params.dimensions.height_mm}`,
    );
    assert.ok(wide.params.form.flatten > tall.params.form.flatten);
  });

  it('carries the photographed colour onto the stone', () => {
    const derived = deriveFrom({ background: [20, 200, 20], rock: [170, 120, 80] });
    assert.equal(derived.params.material.color, '#aa7850');
  });

  it('facets a banded rock and rounds a smooth one', () => {
    const banded = deriveFrom({ background: GRASS, rock: GREY_ROCK, stripes: 40 });
    const smooth = deriveFrom({ background: GRASS, rock: GREY_ROCK });

    assert.ok(banded.params.surface.faceting > smooth.params.surface.faceting + 0.2);
    assert.ok(banded.params.form.roundness < smooth.params.form.roundness);
  });

  it('roughens a broken rock and erodes a smooth one', () => {
    const broken = deriveFrom({ background: GRASS, rock: GREY_ROCK, rockNoise: 70 });
    const smooth = deriveFrom({ background: GRASS, rock: GREY_ROCK });

    assert.ok(broken.params.surface.detail > smooth.params.surface.detail);
    assert.ok(broken.params.surface.erosion < smooth.params.surface.erosion);
  });

  it('still reports colour and surface when no outline was found', () => {
    // A box drawn wholly inside a rock: one texture edge to edge, so the
    // border band and the middle are the same material and nothing stands out.
    const analysis = analyseRock(
      paintRock({ background: GREY_ROCK, rock: GREY_ROCK, rockNoise: 45, backgroundNoise: 45 }),
    );
    assert.equal(analysis.silhouette, null);

    const derived = deriveStoneFromImage(DEFAULT_PARAMS, analysis);

    // Proportions are left as they were, rather than guessed at.
    assert.deepEqual(derived.params.dimensions, DEFAULT_PARAMS.dimensions);
    assert.notEqual(derived.params.material.color, DEFAULT_PARAMS.material.color);
    assert.ok(derived.notes.some((note) => /could be separated/.test(note)));
  });

  it('stays inside every parameter limit, for any photograph', () => {
    const cases: Paint[] = [
      { background: GRASS, rock: GREY_ROCK },
      { background: GRASS, rock: GREY_ROCK, rockNoise: 120, stripes: 80 },
      { background: [0, 0, 0], rock: [255, 255, 255], highlight: 0.7 },
      { background: GREY_ROCK, rock: GREY_ROCK },
      { background: GRASS, rock: GREY_ROCK, radiusX: 0.48, radiusY: 0.06 },
    ];

    for (const options of cases) {
      const { form, surface, material, dimensions } = deriveFrom(options).params;

      for (const [name, value] of Object.entries(form)) {
        const floor = name === 'taper' ? -1 : 0;
        assert.ok(value >= floor && value <= 1, `form.${name} was ${value}`);
      }
      for (const [name, value] of Object.entries(surface)) {
        if (name === 'resolution') continue;
        assert.ok(value >= 0 && value <= 1, `surface.${name} was ${value}`);
      }
      for (const [name, value] of Object.entries(material)) {
        if (typeof value !== 'number') {
          assert.match(value, /^#[0-9a-f]{6}$/, `material.${name} was ${value}`);
          continue;
        }
        assert.ok(value >= 0 && value <= 1, `material.${name} was ${value}`);
      }
      for (const [name, value] of Object.entries(dimensions)) {
        assert.ok(value >= 1 && Number.isFinite(value), `dimensions.${name} was ${value}`);
      }
    }
  });

  it('explains what it did', () => {
    const derived = deriveFrom({ background: GRASS, rock: GREY_ROCK, stripes: 40 });
    assert.ok(derived.notes.length >= 3);
    for (const note of derived.notes) assert.ok(note.length > 12);
  });
});

describe('naming what it found', () => {
  it('calls banded rock angular and smooth rock worn', () => {
    const banded = analyseRock(paintRock({ background: GRASS, rock: GREY_ROCK, stripes: 45, rockNoise: 40 }));
    const smooth = analyseRock(paintRock({ background: GRASS, rock: GREY_ROCK }));

    assert.match(characteriseRock(banded), /Fractured|Cleaved/);
    assert.match(characteriseRock(smooth), /Worn|Weathered|polished/);
  });
});
