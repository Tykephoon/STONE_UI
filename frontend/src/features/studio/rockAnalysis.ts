/**
 * Reading a rock out of a photograph.
 *
 * The studio can already build a stone from a place. This builds one from a
 * picture: point at a rock in a photo or a video frame, draw a box round it,
 * and the generator takes its colour, its surface, and its silhouette from
 * what is actually in those pixels.
 *
 * **On "AI".** There is no model call here, and there cannot be: every hosted
 * vision API needs a key, this is a static site, and a key in a static bundle
 * is a published key — the one rule this project does not bend. What runs
 * instead is ordinary computer vision, all of it local and all of it in this
 * file: segmentation against the background, gradient statistics for texture,
 * structure-tensor coherence for flat faces, and a radial profile of the
 * silhouette. That is less clever than a model and much more legible — every
 * number the panel shows can be traced to an operation you can read here.
 *
 * What it can and cannot know:
 *
 *   - Colour, texture, and the outline facing the camera are measured.
 *   - **Depth is not.** One photograph has no second viewpoint, so the stone is
 *     built as though it were about as deep as it is wide. The panel says so
 *     rather than implying the back was seen.
 *
 * Everything here is arithmetic over a pixel buffer, so what a photo turns
 * into is testable without a browser or a canvas.
 */
import type { DesignParams } from '../../data/types';
import { CONTROL_POINT_DIRECTIONS, emptySculpt } from './controlPoints';

/**
 * Structurally what `ImageData` is, without depending on the DOM.
 *
 * The browser passes a real `ImageData`; the tests pass a plain object. Both
 * satisfy this, which is what keeps the interesting half of the feature
 * runnable under `node --test`.
 */
export interface PixelGrid {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const clamp01 = (value: number): number => clamp(value, 0, 1);

/** Rec. 709 luma, the perceptual grey of a colour. */
const luma = (r: number, g: number, b: number): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

function toHex(r: number, g: number, b: number): string {
  const channel = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Longest edge of the buffer the analysis actually runs on.
 *
 * A phone photograph is several thousand pixels across, and none of the
 * measurements below get better for it — texture is scaled to the sample
 * spacing either way, and segmentation gets slower and no more accurate. This
 * also bounds the work, so dropping in a 48-megapixel image cannot lock the
 * tab up.
 */
export const WORKING_SIZE = 384;

/** Box-filter downsample to at most `WORKING_SIZE` on the longest edge. */
export function downsample(image: PixelGrid, longestEdge = WORKING_SIZE): PixelGrid {
  const scale = Math.min(1, longestEdge / Math.max(image.width, image.height));
  if (scale >= 1) return image;

  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const out = new Uint8ClampedArray(width * height * 4);

  const xStep = image.width / width;
  const yStep = image.height / height;

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * yStep);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yStep));

    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * xStep);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xStep));

      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;

      for (let sy = y0; sy < y1 && sy < image.height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < image.width; sx += 1) {
          const index = (sy * image.width + sx) * 4;
          r += image.data[index]!;
          g += image.data[index + 1]!;
          b += image.data[index + 2]!;
          count += 1;
        }
      }

      const target = (y * width + x) * 4;
      out[target] = r / count;
      out[target + 1] = g / count;
      out[target + 2] = b / count;
      out[target + 3] = 255;
    }
  }

  return { data: out, width, height };
}

/* -------------------------------------------------------------------------
   Separating the rock from what it is sitting on
   ------------------------------------------------------------------------- */

/**
 * Fraction of the selection treated as known background.
 *
 * The user drew a box around a rock, so the band just inside the edge of that
 * box is the ground, the grass, or the table. Learning the background from
 * there rather than assuming a colour is what lets this work on a rock in
 * snow and a rock on asphalt without being told which.
 *
 * The limitation this buys: a box whose border spans two very different
 * things — half grass, half shadowed tarmac — has a large spread, and a rock
 * of middling colour may not stand three deviations clear of it. That fails
 * toward finding nothing rather than toward finding the wrong thing, and the
 * panel asks for a better box. Dragging the box so its edge sits on one
 * surface is the fix, which is why the hint says to include some ground
 * rather than to include the whole scene.
 */
const BORDER_BAND = 0.09;

export interface Mask {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly area: number;
}

/**
 * Classify each pixel as rock or background.
 *
 * Distance from the border's mean colour, scaled by the border's own spread
 * per channel, so a noisy background needs a bigger departure to count as
 * something else. Then the connected blob touching the middle is kept, which
 * discards a second rock at the edge of the box and any speckle the threshold
 * let through.
 */
export function segmentSubject(image: PixelGrid): Mask {
  const { width, height, data } = image;

  const bandX = Math.max(1, Math.round(width * BORDER_BAND));
  const bandY = Math.max(1, Math.round(height * BORDER_BAND));

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumR2 = 0;
  let sumG2 = 0;
  let sumB2 = 0;
  let count = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const onBorder = x < bandX || x >= width - bandX || y < bandY || y >= height - bandY;
      if (!onBorder) continue;

      const index = (y * width + x) * 4;
      const r = data[index]!;
      const g = data[index + 1]!;
      const b = data[index + 2]!;

      sumR += r;
      sumG += g;
      sumB += b;
      sumR2 += r * r;
      sumG2 += g * g;
      sumB2 += b * b;
      count += 1;
    }
  }

  const meanR = sumR / count;
  const meanG = sumG / count;
  const meanB = sumB / count;

  // A floor on the spread: a perfectly flat background has zero variance, and
  // dividing by it would make every pixel infinitely far away.
  const spread = (sum2: number, mean: number): number =>
    Math.max(10, Math.sqrt(Math.max(0, sum2 / count - mean * mean)));

  const spreadR = spread(sumR2, meanR);
  const spreadG = spread(sumG2, meanG);
  const spreadB = spread(sumB2, meanB);

  // Three standard deviations from the background, in the background's own
  // units. Far enough that ordinary background noise does not qualify.
  const THRESHOLD = 3;

  const candidate = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < candidate.length; i += 1, p += 4) {
    const dr = (data[p]! - meanR) / spreadR;
    const dg = (data[p + 1]! - meanG) / spreadG;
    const db = (data[p + 2]! - meanB) / spreadB;
    candidate[i] = Math.sqrt(dr * dr + dg * dg + db * db) > THRESHOLD ? 1 : 0;
  }

  return largestComponentNearCentre(candidate, width, height);
}

/**
 * Keep one blob: the one that covers most of the middle of the selection.
 *
 * Ranked by how much of the central area it occupies, not by its total size.
 * The user drew a box around a rock, so the rock is what is in the middle —
 * and a shadow or a second stone along one edge can easily have more area
 * than the subject while barely touching the centre at all. Size only breaks
 * ties, which happen when nothing reaches the middle.
 */
function largestComponentNearCentre(candidate: Uint8Array, width: number, height: number): Mask {
  const labels = new Int32Array(width * height).fill(-1);
  const stack: number[] = [];

  const centreX0 = Math.floor(width * 0.3);
  const centreX1 = Math.ceil(width * 0.7);
  const centreY0 = Math.floor(height * 0.3);
  const centreY1 = Math.ceil(height * 0.7);

  let best = -1;
  let bestCentre = 0;
  let bestSize = -1;
  let label = 0;

  for (let start = 0; start < candidate.length; start += 1) {
    if (candidate[start] !== 1 || labels[start] !== -1) continue;

    stack.push(start);
    labels[start] = label;

    let size = 0;
    let centreHits = 0;

    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index - x) / width;

      size += 1;
      if (x >= centreX0 && x < centreX1 && y >= centreY0 && y < centreY1) centreHits += 1;

      if (x > 0 && candidate[index - 1] === 1 && labels[index - 1] === -1) {
        labels[index - 1] = label;
        stack.push(index - 1);
      }
      if (x < width - 1 && candidate[index + 1] === 1 && labels[index + 1] === -1) {
        labels[index + 1] = label;
        stack.push(index + 1);
      }
      if (y > 0 && candidate[index - width] === 1 && labels[index - width] === -1) {
        labels[index - width] = label;
        stack.push(index - width);
      }
      if (y < height - 1 && candidate[index + width] === 1 && labels[index + width] === -1) {
        labels[index + width] = label;
        stack.push(index + width);
      }
    }

    if (centreHits > bestCentre || (centreHits === bestCentre && centreHits > 0 && size > bestSize)) {
      bestCentre = centreHits;
      bestSize = size;
      best = label;
    }

    label += 1;
  }

  const mask = new Uint8Array(width * height);
  let area = 0;

  if (best >= 0 && bestCentre > 0) {
    for (let i = 0; i < mask.length; i += 1) {
      if (labels[i] === best) {
        mask[i] = 1;
        area += 1;
      }
    }
  }

  return { data: mask, width, height, area };
}

/* -------------------------------------------------------------------------
   Shape
   ------------------------------------------------------------------------- */

/** How many directions the outline is sampled in. Matches nothing else by design. */
export const RADIAL_SAMPLES = 48;

export interface Silhouette {
  /** Bounding box proportions of the rock itself, not of the selection. */
  widthOverHeight: number;
  /** Area over bounding-box area. A rectangle is 1, an ellipse about 0.79. */
  fillRatio: number;
  /** Area over convex-hull area. Below 1 means lobed or notched. */
  convexity: number;
  /** Distance from the centroid to the outline, by angle. Angle 0 is +x, then anticlockwise. */
  profile: number[];
  /** Mean of `profile`, in pixels — the scale everything else is relative to. */
  meanRadius: number;
}

export function describeSilhouette(mask: Mask): Silhouette | null {
  const { width, height, data, area } = mask;

  // Too little and there is nothing to measure; too much and the box was
  // drawn inside the rock, so its edge is the box's edge and means nothing.
  if (area < width * height * 0.04 || area > width * height * 0.96) return null;

  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  let sumX = 0;
  let sumY = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[y * width + x] !== 1) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumX += x;
      sumY += y;
    }
  }

  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  const centreX = sumX / area;
  const centreY = sumY / area;

  // Radial profile. The ray walks outward and remembers the last filled step,
  // so a notch part way along does not truncate the radius at the notch.
  const profile: number[] = [];
  const limit = Math.hypot(width, height);

  for (let i = 0; i < RADIAL_SAMPLES; i += 1) {
    const angle = (i / RADIAL_SAMPLES) * Math.PI * 2;
    const dx = Math.cos(angle);
    // Image y grows downward; the profile is in maths orientation.
    const dy = -Math.sin(angle);

    let furthest = 0;
    for (let r = 0.5; r < limit; r += 0.5) {
      const x = Math.round(centreX + dx * r);
      const y = Math.round(centreY + dy * r);
      if (x < 0 || x >= width || y < 0 || y >= height) break;
      if (data[y * width + x] === 1) furthest = r;
    }

    profile.push(furthest);
  }

  const meanRadius = profile.reduce((total, r) => total + r, 0) / profile.length;
  if (meanRadius <= 0) return null;

  return {
    widthOverHeight: boxWidth / boxHeight,
    fillRatio: area / (boxWidth * boxHeight),
    convexity: clamp01(area / Math.max(area, convexHullArea(mask))),
    profile,
    meanRadius,
  };
}

/** Area of the convex hull of the mask, by monotone chain over its boundary. */
function convexHullArea(mask: Mask): number {
  const { width, height, data } = mask;
  const points: [number, number][] = [];

  // Only the extreme filled pixel in each row and column can be on the hull,
  // which is a large saving over feeding it every filled pixel.
  for (let y = 0; y < height; y += 1) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x += 1) {
      if (data[y * width + x] !== 1) continue;
      if (first < 0) first = x;
      last = x;
    }
    if (first >= 0) {
      points.push([first, y]);
      points.push([last, y]);
    }
  }

  if (points.length < 3) return 0;

  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const build = (sequence: [number, number][]): [number, number][] => {
    const out: [number, number][] = [];
    for (const point of sequence) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, point) <= 0) {
        out.pop();
      }
      out.push(point);
    }
    out.pop();
    return out;
  };

  const hull = [...build(points), ...build([...points].reverse())];
  if (hull.length < 3) return 0;

  let twiceArea = 0;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }

  return Math.abs(twiceArea) / 2;
}

/* -------------------------------------------------------------------------
   Surface
   ------------------------------------------------------------------------- */

export interface SurfaceStats {
  /** Mean gradient magnitude, normalised. How broken the surface reads. */
  roughness: number;
  /** Fine detail relative to coarse. High means sandpaper, low means boulders. */
  grain: number;
  /** Straight, consistently oriented edges — flat faces rather than curves. */
  faceting: number;
  /** Small bright or dark flecks against the local average. */
  speckle: number;
  /** Fraction of the surface in specular highlight. */
  gloss: number;
}

/**
 * Measure the surface, over the masked pixels only.
 *
 * Background is excluded throughout: the edge between a rock and the grass is
 * the strongest gradient in the picture, and counting it would make every rock
 * on an interesting background read as violently rough.
 */
export function measureSurface(image: PixelGrid, mask: Mask | null): SurfaceStats {
  const { width, height, data } = image;

  const inside = (x: number, y: number): boolean =>
    !mask || mask.area === 0 || mask.data[y * width + x] === 1;

  const grey = new Float32Array(width * height);
  for (let i = 0, p = 0; i < grey.length; i += 1, p += 4) {
    grey[i] = luma(data[p]!, data[p + 1]!, data[p + 2]!);
  }

  // Gradients first, kept whole, because the coherence pass below needs a
  // neighbourhood of them and cannot be folded into a single sweep.
  const gx = new Float32Array(width * height);
  const gy = new Float32Array(width * height);
  const usable = new Uint8Array(width * height);

  let gradientTotal = 0;
  let laplacianTotal = 0;
  let lumaTotal = 0;
  let lumaSquares = 0;
  let samples = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      // Every pixel of the 3x3 neighbourhood must be on the rock, or the
      // measurement straddles the edge it is meant to ignore — and the rock
      // against its background is the strongest gradient in the picture.
      if (
        !inside(x, y) ||
        !inside(x - 1, y) ||
        !inside(x + 1, y) ||
        !inside(x, y - 1) ||
        !inside(x, y + 1)
      ) {
        continue;
      }

      const index = y * width + x;
      const here = grey[index]!;
      const west = grey[index - 1]!;
      const east = grey[index + 1]!;
      const north = grey[index - width]!;
      const south = grey[index + width]!;

      const dx = (east - west) / 2;
      const dy = (south - north) / 2;

      gx[index] = dx;
      gy[index] = dy;
      usable[index] = 1;

      gradientTotal += Math.hypot(dx, dy);
      laplacianTotal += Math.abs(east + west + north + south - 4 * here);

      lumaTotal += here;
      lumaSquares += here * here;
      samples += 1;
    }
  }

  if (samples === 0) {
    return { roughness: 0.4, grain: 0.4, faceting: 0.1, speckle: 0.2, gloss: 0 };
  }

  /*
    Structure-tensor coherence, over a window rather than per pixel.

    This must be windowed to mean anything. A single pixel's tensor is the
    outer product of one gradient with itself: rank one, coherence exactly 1,
    for every pixel of every image including pure noise. Summing over a
    neighbourhood is what makes the number a question about agreement — it
    stays near 1 where an edge runs straight through the window, and collapses
    toward 0 where the gradients point every which way.

    That is the difference between a cleaved face and a pitted one, and it is
    the whole reason this measurement exists.
  */
  const RADIUS = 2;
  let coherenceTotal = 0;
  let coherenceSamples = 0;

  for (let y = RADIUS; y < height - RADIUS; y += 1) {
    for (let x = RADIUS; x < width - RADIUS; x += 1) {
      let jxx = 0;
      let jyy = 0;
      let jxy = 0;
      let covered = 0;

      for (let wy = -RADIUS; wy <= RADIUS; wy += 1) {
        for (let wx = -RADIUS; wx <= RADIUS; wx += 1) {
          const index = (y + wy) * width + (x + wx);
          if (usable[index] !== 1) continue;
          const a = gx[index]!;
          const b = gy[index]!;
          jxx += a * a;
          jyy += b * b;
          jxy += a * b;
          covered += 1;
        }
      }

      const window = (RADIUS * 2 + 1) ** 2;
      // A partly masked window straddles the outline; a flat one has no
      // orientation to speak of. Neither says anything about the surface.
      if (covered < window * 0.9) continue;

      const trace = jxx + jyy;
      if (trace < covered * 1.5) continue;

      coherenceTotal += Math.hypot(jxx - jyy, 2 * jxy) / trace;
      coherenceSamples += 1;
    }
  }

  const meanLuma = lumaTotal / samples;
  const deviation = Math.sqrt(Math.max(0, lumaSquares / samples - meanLuma * meanLuma));

  // Specular highlights: well above the rock's own spread, not merely bright.
  const highlight = meanLuma + 2.5 * deviation;
  let brightTotal = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      if (usable[y * width + x] !== 1) continue;
      if (grey[y * width + x]! > highlight) brightTotal += 1;
    }
  }

  // Gradient at a quarter resolution: the same surface measured with four
  // times the spacing. Coarse rubble keeps its contrast there; fine grain
  // averages away. The ratio is what tells them apart, and it is the only
  // reason this is measured twice.
  const coarse = downsample(image, Math.max(8, Math.round(Math.max(width, height) / 4)));
  const coarseGradient = meanGradient(coarse);
  const fineGradient = gradientTotal / samples;

  const faceting =
    coherenceSamples > 0 ? clamp01((coherenceTotal / coherenceSamples) * 1.5 - 0.35) : 0;

  /*
    The constants below are calibrated, not guessed. Synthesising surfaces of
    known grain size and contrast and printing these five numbers showed the
    first pass pinning three of them at 1.0 for anything with fine detail —
    which is most photographs of most rocks, and which made the readout useless
    precisely where it should be discriminating.

    Divisors are set so an ordinary textured rock lands mid-range and only a
    genuinely extreme surface reaches the ends.
  */
  const grainRatio = coarseGradient > 0.01 ? fineGradient / coarseGradient : 0;

  return {
    roughness: clamp01(fineGradient / 22),
    // Detail that survives a 4x downsample is coarse; detail that averages
    // away is fine. Measured, the ratio runs about 0.5 for boulders to 2.1
    // for sand, so that is the range this is stretched across.
    grain: clamp01((grainRatio - 0.5) / 1.6),
    faceting,
    speckle: clamp01(laplacianTotal / samples / 40),
    gloss: clamp01((brightTotal / samples) * 9),
  };
}

function meanGradient(image: PixelGrid): number {
  const { width, height, data } = image;
  if (width < 3 || height < 3) return 0;

  let total = 0;
  let samples = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const at = (ox: number, oy: number): number => {
        const p = ((y + oy) * width + (x + ox)) * 4;
        return luma(data[p]!, data[p + 1]!, data[p + 2]!);
      };
      total += Math.hypot((at(1, 0) - at(-1, 0)) / 2, (at(0, 1) - at(0, -1)) / 2);
      samples += 1;
    }
  }

  return samples > 0 ? total / samples : 0;
}

/* -------------------------------------------------------------------------
   Colour
   ------------------------------------------------------------------------- */

export interface RockColour {
  color: string;
  accentColor: string;
}

/**
 * The rock's colour, and the colour of its shadows.
 *
 * The base is the average over the masked pixels. The accent comes from the
 * darkest fifth, because that is what a crevice looks like in the same light —
 * inventing a darker shade of the average instead would lose the colour shift
 * that makes wet slate look different from dry sandstone.
 */
export function measureColour(image: PixelGrid, mask: Mask | null): RockColour {
  const { width, height, data } = image;

  const pixels: { r: number; g: number; b: number; l: number }[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask && mask.area > 0 && mask.data[y * width + x] !== 1) continue;
      const p = (y * width + x) * 4;
      const r = data[p]!;
      const g = data[p + 1]!;
      const b = data[p + 2]!;
      pixels.push({ r, g, b, l: luma(r, g, b) });
    }
  }

  if (pixels.length === 0) return { color: '#8a8577', accentColor: '#5c5850' };

  let r = 0;
  let g = 0;
  let b = 0;
  for (const pixel of pixels) {
    r += pixel.r;
    g += pixel.g;
    b += pixel.b;
  }
  const count = pixels.length;

  pixels.sort((a, z) => a.l - z.l);
  const darkCount = Math.max(1, Math.floor(pixels.length * 0.2));

  let dr = 0;
  let dg = 0;
  let db = 0;
  for (let i = 0; i < darkCount; i += 1) {
    dr += pixels[i]!.r;
    dg += pixels[i]!.g;
    db += pixels[i]!.b;
  }

  return {
    color: toHex(r / count, g / count, b / count),
    accentColor: toHex(dr / darkCount, dg / darkCount, db / darkCount),
  };
}

/* -------------------------------------------------------------------------
   The whole reading
   ------------------------------------------------------------------------- */

export interface RockAnalysis {
  colour: RockColour;
  surface: SurfaceStats;
  /** Null when no rock could be separated from the background. */
  silhouette: Silhouette | null;
  /** Share of the selection identified as rock, 0 to 1. */
  coverage: number;
  /** Size of the buffer actually analysed. */
  analysedWidth: number;
  analysedHeight: number;
}

export function analyseRock(source: PixelGrid): RockAnalysis {
  const image = downsample(source);
  const mask = segmentSubject(image);
  const usable = mask.area > 0 ? mask : null;

  return {
    colour: measureColour(image, usable),
    surface: measureSurface(image, usable),
    silhouette: usable ? describeSilhouette(usable) : null,
    coverage: mask.area / (image.width * image.height),
    analysedWidth: image.width,
    analysedHeight: image.height,
  };
}

/* -------------------------------------------------------------------------
   Turning the reading into a stone
   ------------------------------------------------------------------------- */

/**
 * The silhouette as control-point pulls.
 *
 * Each handle's direction is projected onto the image plane and the outline's
 * radius read at that angle, so the stone's profile follows the rock in the
 * photograph. Two departures, for the same reasons as the terrain version:
 *
 *   - Handles pointing away from the camera are pulled toward the average.
 *     Their radius is a guess — one photograph has no depth — and shaping them
 *     as confidently as the visible ones would be inventing detail.
 *   - Influence fades to nothing at the bottom pole, so the stone keeps a face
 *     to print on.
 */
export function pullsFromSilhouette(silhouette: Silhouette): number[] {
  const { profile, meanRadius } = silhouette;

  // Only x and y matter: the photograph is a projection onto that plane, and
  // the depth component is exactly what it cannot tell us.
  const raw = CONTROL_POINT_DIRECTIONS.map(([x, y]) => {
    const inPlane = Math.hypot(x, y);
    // Straight along the view axis there is no angle to read a radius at.
    if (inPlane < 1e-6) return 0;

    let angle = Math.atan2(y, x);
    if (angle < 0) angle += Math.PI * 2;

    const position = (angle / (Math.PI * 2)) * profile.length;
    const i0 = Math.floor(position) % profile.length;
    const i1 = (i0 + 1) % profile.length;
    const t = position - Math.floor(position);
    const radius = profile[i0]! * (1 - t) + profile[i1]! * t;

    const offset = (radius - meanRadius) / meanRadius;

    // Confidence falls with how far the handle points away from the camera,
    // and with height, exactly as the terrain derivation does.
    const facing = inPlane;
    const vertical = y >= 0 ? 0.45 + 0.55 * y : 0.45 * (1 + y);

    return clamp(offset, -1, 1) * facing * vertical;
  });

  const strongest = raw.reduce((peak, pull) => Math.max(peak, Math.abs(pull)), 0);
  if (strongest < 1e-6) return raw;

  const gain = Math.min(0.8 / strongest, 3);
  return raw.map((pull) => clamp(pull * gain, -1, 1));
}

/** A short name for the kind of rock this reads as. */
export function characteriseRock(analysis: RockAnalysis): string {
  const { faceting, roughness, gloss } = analysis.surface;

  if (faceting > 0.5 && roughness > 0.45) return 'Fractured, angular';
  if (faceting > 0.5) return 'Cleaved, flat-faced';
  if (roughness > 0.6) return 'Coarse and pitted';
  if (gloss > 0.4) return 'Smooth, polished';
  if (roughness < 0.25) return 'Worn smooth';
  return 'Weathered, even';
}

export interface ImageDerivation {
  params: DesignParams;
  character: string;
  notes: string[];
}

/**
 * Build a stone from a photograph.
 *
 * `base` supplies what the picture has no opinion about — above all the
 * printed length, which is never changed here for the same reason it is never
 * changed by the terrain derivation: the photograph decides the shape, the
 * user decides the size.
 */
export function deriveStoneFromImage(base: DesignParams, analysis: RockAnalysis): ImageDerivation {
  const { colour, surface, silhouette } = analysis;
  const length = base.dimensions.length_mm;
  const notes: string[] = [];

  notes.push(
    `Colour and surface read from ${analysis.analysedWidth}×${analysis.analysedHeight} pixels of the selection.`,
  );

  notes.push(
    surface.faceting > 0.45
      ? 'Straight, consistently angled edges — this reads as flat fractured faces, so the generator facets it.'
      : 'Edges curve rather than run straight, so the form stays rounded.',
  );

  notes.push(
    surface.grain > 0.55
      ? 'Detail is fine relative to the coarse structure: a tight, sandy grain.'
      : 'Detail holds up at low resolution, so the grain is coarse and blocky.',
  );

  let dimensions = base.dimensions;

  if (silhouette) {
    // The photograph shows one face. Depth is unmeasurable from it, so the
    // stone is built about as deep as it is wide, which is the least
    // surprising assumption and is stated rather than hidden.
    const heightRatio = clamp(1 / Math.max(0.2, silhouette.widthOverHeight), 0.25, 1);
    const widthRatio = clamp(0.55 + silhouette.fillRatio * 0.35, 0.4, 1);

    dimensions = {
      length_mm: length,
      width_mm: Math.round(length * widthRatio),
      height_mm: Math.round(length * heightRatio),
    };

    notes.push(
      `The outline is ${silhouette.widthOverHeight.toFixed(2)}:1 across, which sets the height at ${(heightRatio * 100).toFixed(0)}% of the length. Depth is not visible in one photograph, so it is assumed similar to the width.`,
    );

    if (silhouette.convexity < 0.9) {
      notes.push('The outline is notched rather than smooth, so the asymmetry is raised to match.');
    }
  } else {
    notes.push(
      'No rock could be separated from the background, so only colour and surface were taken. Draw the box so it includes some of what the rock is sitting on.',
    );
  }

  const params: DesignParams = {
    ...base,
    dimensions,
    form: {
      roundness: clamp01(0.8 - surface.faceting * 0.55 - surface.roughness * 0.15),
      taper: base.form.taper,
      asymmetry: clamp01(
        0.2 + surface.roughness * 0.3 + (silhouette ? (1 - silhouette.convexity) * 2.2 : 0),
      ),
      flatten: silhouette
        ? clamp01(0.15 + clamp01(silhouette.widthOverHeight - 1) * 0.5)
        : base.form.flatten,
      bulge: silhouette ? clamp01(silhouette.fillRatio * 0.7) : base.form.bulge,
    },
    surface: {
      ...base.surface,
      detail: clamp01(0.2 + surface.roughness * 0.7),
      grain: clamp01(0.15 + surface.grain * 0.7),
      // What is still sharp has not worn; the two are opposites.
      erosion: clamp01(0.8 - surface.roughness * 0.5 - surface.faceting * 0.35),
      faceting: surface.faceting,
    },
    material: {
      ...base.material,
      color: colour.color,
      accentColor: colour.accentColor,
      speckle: clamp01(surface.speckle),
      // A rock that catches the light is smoother and slightly lacquered.
      roughness: clamp01(0.95 - surface.gloss * 0.45),
      clearcoat: clamp01(surface.gloss * 0.6),
    },
  };

  return {
    params: {
      ...params,
      sculpt: {
        ...(base.sculpt ?? emptySculpt()),
        pulls: silhouette
          ? pullsFromSilhouette(silhouette)
          : (base.sculpt ?? emptySculpt()).pulls,
      },
    },
    character: characteriseRock(analysis),
    notes,
  };
}
