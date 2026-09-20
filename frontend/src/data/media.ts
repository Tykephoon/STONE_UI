/**
 * Getting pixels out of a file the user dropped in.
 *
 * Images are straightforward. Video is the reason this module exists: a clip
 * of a rock is far easier to take than a good photograph of one, and any one
 * frame of it may be blurred, badly lit, or pointed at something else. So the
 * user scrubs to a frame they like and takes that.
 *
 * Nothing here is uploaded. The file is read by this tab, decoded by this tab,
 * and never leaves the machine — there is no server to send it to, which is
 * also why the analysis that follows is local. See `features/studio/rockAnalysis.ts`.
 *
 * Object URLs are the one resource here that leaks if ignored: a revoked URL
 * costs nothing, an un-revoked one pins the whole decoded video in memory for
 * the life of the tab. Every creation below has a matching `releaseMedia`.
 */

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaError';
  }
}

/**
 * Size ceilings, chosen to fail early with a sentence rather than late with a
 * dead tab. Decoding is what costs, and it costs roughly with file size.
 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024;

export const ACCEPTED_TYPES = 'image/*,video/*';

export interface LoadedImage {
  kind: 'image';
  bitmap: ImageBitmap;
  width: number;
  height: number;
  name: string;
}

export interface LoadedVideo {
  kind: 'video';
  element: HTMLVideoElement;
  url: string;
  /** Seconds. Zero when the browser will not report it. */
  duration: number;
  width: number;
  height: number;
  name: string;
}

export type LoadedMedia = LoadedImage | LoadedVideo;

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export async function loadMedia(file: File): Promise<LoadedMedia> {
  const isVideo = file.type.startsWith('video/');
  const isImage = file.type.startsWith('image/');

  if (!isVideo && !isImage) {
    throw new MediaError('That is not an image or a video.');
  }

  const limit = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (file.size > limit) {
    throw new MediaError(`That file is ${megabytes(file.size)}. The limit is ${megabytes(limit)}.`);
  }

  return isVideo ? loadVideo(file) : loadImage(file);
}

async function loadImage(file: File): Promise<LoadedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Usually a file whose extension and contents disagree, or a format this
    // browser has no decoder for.
    throw new MediaError('That image could not be decoded.');
  }

  return {
    kind: 'image',
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    name: file.name,
  };
}

function loadVideo(file: File): Promise<LoadedVideo> {
  const url = URL.createObjectURL(file);
  const element = document.createElement('video');

  // Muted and inline so a browser will decode without a gesture, and
  // `preload="auto"` so seeking does not have to fetch as it goes.
  element.muted = true;
  element.playsInline = true;
  element.preload = 'auto';
  // The frame is read back through a canvas, which taints on a cross-origin
  // source. A blob URL from a local file is same-origin, but being explicit
  // keeps that true if the source ever changes.
  element.crossOrigin = 'anonymous';
  element.src = url;

  return new Promise<LoadedVideo>((resolve, reject) => {
    const fail = (message: string) => {
      URL.revokeObjectURL(url);
      reject(new MediaError(message));
    };

    element.addEventListener(
      'loadedmetadata',
      () => {
        if (!element.videoWidth || !element.videoHeight) {
          fail('That video has no picture this browser can read.');
          return;
        }

        resolve({
          kind: 'video',
          element,
          url,
          // Some containers report Infinity until they have been played
          // through. Zero is the honest answer, and the UI treats it as "no
          // scrubbing available" rather than showing an infinite track.
          duration: Number.isFinite(element.duration) ? element.duration : 0,
          width: element.videoWidth,
          height: element.videoHeight,
          name: file.name,
        });
      },
      { once: true },
    );

    element.addEventListener(
      'error',
      () => fail('That video could not be decoded. Try MP4 or WebM.'),
      { once: true },
    );
  });
}

export function releaseMedia(media: LoadedMedia | null): void {
  if (!media) return;

  if (media.kind === 'image') {
    media.bitmap.close();
    return;
  }

  media.element.pause();
  media.element.removeAttribute('src');
  media.element.load();
  URL.revokeObjectURL(media.url);
}

/**
 * Move a video to a time and wait until that frame is actually showing.
 *
 * `currentTime = t` returns immediately and the picture arrives later, so
 * reading the canvas without waiting for `seeked` reliably grabs the previous
 * frame — which looks like an off-by-one that only appears when scrubbing
 * quickly.
 */
export function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const target = Math.max(0, time);

    if (Math.abs(video.currentTime - target) < 1e-3 && video.readyState >= 2) {
      resolve();
      return;
    }

    const done = () => {
      video.removeEventListener('seeked', done);
      resolve();
    };

    video.addEventListener('seeked', done, { once: true });
    video.currentTime = target;

    // A seek past the end, or into a gap, may never fire. Resolving anyway
    // draws a slightly stale frame, which beats a control that hangs.
    setTimeout(done, 1500);
  });
}

/** A rectangle in 0–1 of the frame, so it survives the frame being resized. */
export interface NormalisedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FULL_FRAME: NormalisedRect = { x: 0, y: 0, width: 1, height: 1 };

/** The pixels of a region, ready to analyse. */
export function cropRegion(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  rect: NormalisedRect,
  maxEdge = 512,
): ImageData {
  // A selection smaller than a few pixels has nothing to measure; clamping
  // here keeps every caller from having to guard the degenerate drag.
  const sx = Math.round(clamp01(rect.x) * sourceWidth);
  const sy = Math.round(clamp01(rect.y) * sourceHeight);
  const sw = Math.max(4, Math.round(clamp01(rect.width) * sourceWidth));
  const sh = Math.max(4, Math.round(clamp01(rect.height) * sourceHeight));

  const width = Math.min(sw, sourceWidth - sx);
  const height = Math.min(sh, sourceHeight - sy);

  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const outWidth = Math.max(4, Math.round(width * scale));
  const outHeight = Math.max(4, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outWidth;
  canvas.height = outHeight;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new MediaError('This browser cannot read image data.');

  context.drawImage(source, sx, sy, width, height, 0, 0, outWidth, outHeight);

  try {
    return context.getImageData(0, 0, outWidth, outHeight);
  } catch {
    throw new MediaError('The picture could not be read back for analysis.');
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Draw the current frame or image into a canvas sized to fit `box`. */
export function drawPreview(
  canvas: HTMLCanvasElement,
  media: LoadedMedia,
  boxWidth: number,
): { width: number; height: number } {
  const aspect = media.height / media.width;
  const width = Math.max(1, Math.round(boxWidth));
  const height = Math.max(1, Math.round(width * aspect));

  // Backing store at device resolution, CSS box at layout resolution: a
  // preview the user is about to draw a selection box on should not be soft.
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const context = canvas.getContext('2d');
  if (context) {
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.drawImage(
      media.kind === 'image' ? media.bitmap : media.element,
      0,
      0,
      width,
      height,
    );
  }

  return { width, height };
}
