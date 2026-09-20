/**
 * Building a stone from a photograph or a video frame.
 *
 * The flow is the one the request described, in order: drop in an image or a
 * clip, scrub to the frame that shows the rock best, drag a box around the
 * part of that frame you mean, and take the reading.
 *
 * Two deliberate choices in how it behaves:
 *
 *   - **The selection includes some background on purpose.** The analysis
 *     learns what the rock is sitting on from the edge of your box, then
 *     separates the rock from it. A box drawn tight inside the rock has no
 *     background to learn from, so the outline cannot be found — the panel
 *     says that outright instead of quietly producing a worse stone.
 *   - **Analysis runs as you adjust, applying only on request.** Reading is
 *     cheap and immediate feedback is what makes the box easy to place;
 *     overwriting a stone someone has already shaped is not something to do
 *     on a drag.
 *
 * Nothing is uploaded. The file is decoded here and the measurements are taken
 * here — see `data/media.ts` and `rockAnalysis.ts`.
 */
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  ACCEPTED_TYPES,
  FULL_FRAME,
  type LoadedMedia,
  MediaError,
  type NormalisedRect,
  cropRegion,
  drawPreview,
  loadMedia,
  releaseMedia,
  seekTo,
} from '../../data/media';
import { Button } from '../../components/ui/Button';
import { Badge, Spinner } from '../../components/ui/Feedback';
import { FieldGroup } from '../../components/ui/Form';
import { DownloadIcon } from '../../components/layout/Icons';
import { formatNumber } from '../../lib/format';
import { type RockAnalysis, analyseRock, characteriseRock } from './rockAnalysis';
import styles from './ImagePanel.module.css';

export interface ImagePanelProps {
  /** Called when the user asks for the stone to be rebuilt from this reading. */
  onShapeFromImage: (analysis: RockAnalysis) => void;
}

/** Smallest selection worth analysing, as a fraction of the frame. */
const MIN_SELECTION = 0.02;

function formatTime(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}.${String(
    Math.floor((seconds - whole) * 10),
  )}`;
}

export function ImagePanel({ onShapeFromImage }: ImagePanelProps): JSX.Element {
  const [media, setMedia] = useState<LoadedMedia | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [time, setTime] = useState(0);
  const [rect, setRect] = useState<NormalisedRect>(FULL_FRAME);
  const [analysis, setAnalysis] = useState<RockAnalysis | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [preview, setPreview] = useState({ width: 0, height: 0 });

  // The loaded media owns an ImageBitmap or an object URL; both have to be
  // released explicitly, including when the panel unmounts mid-session.
  const mediaRef = useRef<LoadedMedia | null>(null);
  mediaRef.current = media;
  useEffect(() => () => releaseMedia(mediaRef.current), []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage || !media) return;

    const width = stage.clientWidth;
    if (width <= 0) return;

    setPreview(drawPreview(canvas, media, width));
  }, [media]);

  useEffect(() => {
    redraw();

    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(redraw);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [redraw]);

  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return;

    setIsLoading(true);
    setError(null);

    try {
      const loaded = await loadMedia(file);
      releaseMedia(mediaRef.current);

      setMedia(loaded);
      setTime(0);
      setRect(FULL_FRAME);
      setAnalysis(null);

      if (loaded.kind === 'video') {
        // Not frame zero: the first frame of a handheld clip is usually the
        // moment the camera was still being aimed.
        const start = loaded.duration > 0 ? Math.min(loaded.duration * 0.15, 2) : 0;
        await seekTo(loaded.element, start);
        setTime(start);
      }
    } catch (cause) {
      setMedia(null);
      setError(cause instanceof MediaError ? cause.message : 'That file could not be read.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  /** Scrub: seek, then redraw the frame that arrived. */
  useEffect(() => {
    if (!media || media.kind !== 'video') return;

    let cancelled = false;
    void seekTo(media.element, time).then(() => {
      if (!cancelled) redraw();
    });

    return () => {
      cancelled = true;
    };
  }, [media, time, redraw]);

  /** Read the selection whenever it, or the frame, settles. */
  useEffect(() => {
    if (!media || isDragging) return;
    if (rect.width < MIN_SELECTION || rect.height < MIN_SELECTION) return;

    const timer = setTimeout(() => {
      try {
        const pixels = cropRegion(
          media.kind === 'image' ? media.bitmap : media.element,
          media.width,
          media.height,
          rect,
        );
        setAnalysis(analyseRock(pixels));
        setError(null);
      } catch (cause) {
        setAnalysis(null);
        setError(cause instanceof MediaError ? cause.message : 'That region could not be read.');
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [media, rect, time, isDragging]);

  /* ---- Drawing the selection box --------------------------------------- */

  const pointToFrame = useCallback((event: ReactPointerEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;

    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      const point = pointToFrame(event);
      if (!point) return;

      event.currentTarget.setPointerCapture(event.pointerId);
      dragStart.current = point;
      setIsDragging(true);
      setRect({ x: point.x, y: point.y, width: 0, height: 0 });
    },
    [pointToFrame],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const start = dragStart.current;
      if (!start) return;

      const point = pointToFrame(event);
      if (!point) return;

      setRect({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
      });
    },
    [pointToFrame],
  );

  const onPointerUp = useCallback((event: ReactPointerEvent) => {
    if (!dragStart.current) return;
    dragStart.current = null;
    setIsDragging(false);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    // A click rather than a drag means "start again with the whole frame",
    // which is a more useful outcome than a selection too small to measure.
    setRect((current) =>
      current.width < MIN_SELECTION || current.height < MIN_SELECTION ? FULL_FRAME : current,
    );
  }, []);

  const surface = analysis?.surface;

  return (
    <div className={styles.panel}>
      <p className={styles.intro}>
        Build the stone from a real rock. Drop in a photo, or a video and scrub to the frame that
        shows it best, then drag a box around it.
      </p>

      <label className={styles.dropzone}>
        <input
          type="file"
          accept={ACCEPTED_TYPES}
          className={styles.fileInput}
          onChange={(event) => void handleFile(event.target.files?.[0])}
        />
        <span className={styles.dropIcon} aria-hidden="true">
          <DownloadIcon size={18} />
        </span>
        <span className={styles.dropText}>
          {media ? media.name : 'Choose an image or video'}
        </span>
        <span className={styles.dropHint}>
          Stays on this machine — there is no server to send it to.
        </span>
      </label>

      {isLoading && (
        <p className={styles.status}>
          <Spinner size={13} /> Decoding…
        </p>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {media && (
        <>
          <div
            ref={stageRef}
            className={styles.stage}
            style={preview.height > 0 ? { height: preview.height } : undefined}
          >
            <canvas
              ref={canvasRef}
              className={styles.canvas}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />

            {rect.width > 0 && rect.height > 0 && (
              <div
                className={styles.selection}
                style={{
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.width * 100}%`,
                  height: `${rect.height * 100}%`,
                }}
              />
            )}
          </div>

          {media.kind === 'video' && media.duration > 0 && (
            <FieldGroup title="Frame">
              <input
                type="range"
                className={styles.scrubber}
                min={0}
                max={media.duration}
                step={Math.max(0.02, media.duration / 600)}
                value={time}
                onChange={(event) => setTime(Number(event.target.value))}
                aria-label="Video position"
              />
              <p className={styles.note}>
                {formatTime(time)} of {formatTime(media.duration)} · {media.width}×{media.height}
              </p>
            </FieldGroup>
          )}

          <div className={styles.selectionRow}>
            <span className={styles.note}>
              {rect === FULL_FRAME || (rect.width > 0.98 && rect.height > 0.98)
                ? 'Whole frame selected. Drag a box around the rock for a better reading.'
                : `Box: ${(rect.width * 100).toFixed(0)}% × ${(rect.height * 100).toFixed(0)}% of the frame.`}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setRect(FULL_FRAME)}>
              Reset box
            </Button>
          </div>
        </>
      )}

      {analysis && surface && (
        <div className={styles.reading}>
          <div className={styles.readingHead}>
            <Badge tone="accent">{characteriseRock(analysis)}</Badge>
            <span className={styles.swatches}>
              <span
                className={styles.swatch}
                style={{ background: analysis.colour.color }}
                title={`Base ${analysis.colour.color}`}
                aria-label={`Base colour ${analysis.colour.color}`}
              />
              <span
                className={styles.swatch}
                style={{ background: analysis.colour.accentColor }}
                title={`Crevices ${analysis.colour.accentColor}`}
                aria-label={`Crevice colour ${analysis.colour.accentColor}`}
              />
            </span>
          </div>

          <dl className={styles.stats}>
            <div>
              <dt>Roughness</dt>
              <dd>{formatNumber(surface.roughness * 100, 0)}%</dd>
            </div>
            <div>
              <dt>Grain</dt>
              <dd>{formatNumber(surface.grain * 100, 0)}%</dd>
            </div>
            <div>
              <dt>Flat faces</dt>
              <dd>{formatNumber(surface.faceting * 100, 0)}%</dd>
            </div>
            <div>
              <dt>Sheen</dt>
              <dd>{formatNumber(surface.gloss * 100, 0)}%</dd>
            </div>
          </dl>

          {analysis.silhouette ? (
            <p className={styles.note}>
              Outline found — {formatNumber(analysis.coverage * 100, 0)}% of the box is rock, at{' '}
              {analysis.silhouette.widthOverHeight.toFixed(2)}:1 across. Its profile becomes the
              stone's. Depth is not visible in one picture, so it is assumed close to the width.
            </p>
          ) : (
            <p className={styles.warn}>
              No outline could be separated from the background, so only colour and surface will be
              used. Draw the box a little wider, so it includes some of what the rock is sitting
              on.
            </p>
          )}

          <Button size="sm" variant="secondary" fullWidth onClick={() => onShapeFromImage(analysis)}>
            Shape the stone from this rock
          </Button>
        </div>
      )}

      {!media && !isLoading && (
        <p className={styles.note}>
          Works on any photo of a rock. The analysis is ordinary computer vision running in this
          tab — colour, texture, and the outline — not a hosted model, because a hosted model would
          need an API key and this app ships no keys.
        </p>
      )}
    </div>
  );
}
