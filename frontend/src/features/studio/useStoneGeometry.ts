/**
 * Drives the generation worker and hands back a three.js BufferGeometry.
 *
 * Regeneration is debounced and request-versioned: dragging a slider produces
 * a burst of parameter changes, and without both, the viewer would flicker
 * between stale results arriving out of order.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BufferAttribute, BufferGeometry } from 'three';
import type { DesignParams } from '../../data/types';
import type {
  GenerateRequest,
  GenerateResponse,
} from './generator/stone.worker';

export interface StoneGeometryState {
  geometry: BufferGeometry | null;
  isGenerating: boolean;
  error: string | null;
  stats: { triangles: number; durationMs: number } | null;
}

/** Slider drags settle within this window before a regeneration is issued. */
const DEBOUNCE_MS = 90;

/**
 * Resolution used while a control point is being dragged.
 *
 * Level 4 is ~5,000 triangles and rebuilds in around 10 ms, so the surface
 * follows the pointer. Level 6 would take 150 ms and turn the drag into a
 * slideshow. The full-detail mesh is rebuilt the moment the drag ends.
 */
const INTERACTIVE_RESOLUTION = 4;

export interface StoneGeometryOptions {
  /** True while the user is dragging; trades detail for responsiveness. */
  interactive?: boolean;
}

export function useStoneGeometry(
  params: DesignParams | null,
  options: StoneGeometryOptions = {},
): StoneGeometryState {
  const { interactive = false } = options;
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const geometryRef = useRef<BufferGeometry | null>(null);

  const [state, setState] = useState<StoneGeometryState>({
    geometry: null,
    isGenerating: false,
    error: null,
    stats: null,
  });

  /**
   * Parameters actually sent to the worker.
   *
   * During a drag the resolution is capped, so the mesh rebuilds fast enough to
   * track the pointer.
   */
  const effectiveParams = useMemo(() => {
    if (!params) return null;
    if (!interactive || params.surface.resolution <= INTERACTIVE_RESOLUTION) return params;
    return {
      ...params,
      surface: { ...params.surface, resolution: INTERACTIVE_RESOLUTION },
    };
  }, [params, interactive]);

  // Serialised parameters, so the effect re-runs on value changes rather than
  // on every new object identity from the parent's render.
  const paramsKey = useMemo(
    () => (effectiveParams ? JSON.stringify(effectiveParams) : null),
    [effectiveParams],
  );

  const handleMessage = useCallback((event: MessageEvent<GenerateResponse>) => {
    const message = event.data;

    // A result from a superseded request is discarded outright.
    if (message.requestId !== requestIdRef.current) return;

    if (!message.ok) {
      setState((current) => ({ ...current, isGenerating: false, error: message.message }));
      return;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(message.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(message.normals, 3));
    geometry.setAttribute('color', new BufferAttribute(message.colors, 3));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();

    // GPU buffers are not garbage collected with the JS object; the previous
    // geometry has to be released explicitly or the editor leaks VRAM on every
    // slider movement.
    geometryRef.current?.dispose();
    geometryRef.current = geometry;

    setState({
      geometry,
      isGenerating: false,
      error: null,
      stats: { triangles: message.triangleCount, durationMs: message.durationMs },
    });
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL('./generator/stone.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.addEventListener('message', handleMessage as EventListener);
    worker.addEventListener('error', () => {
      setState((current) => ({
        ...current,
        isGenerating: false,
        error: 'The geometry engine failed to start.',
      }));
    });
    workerRef.current = worker;

    return () => {
      worker.terminate();
      workerRef.current = null;
      geometryRef.current?.dispose();
      geometryRef.current = null;
    };
  }, [handleMessage]);

  useEffect(() => {
    if (!paramsKey || !effectiveParams) return;

    const worker = workerRef.current;
    if (!worker) return;

    setState((current) => ({ ...current, isGenerating: true }));

    // No debounce while dragging: the whole point is to follow the pointer.
    const delay = interactive ? 0 : DEBOUNCE_MS;

    const timer = setTimeout(() => {
      requestIdRef.current += 1;
      const request: GenerateRequest = {
        requestId: requestIdRef.current,
        params: effectiveParams,
      };
      worker.postMessage(request);
    }, delay);

    return () => clearTimeout(timer);
    // `paramsKey` is the value-identity of `params`; depending on the object
    // itself would regenerate on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey, interactive]);

  return state;
}
