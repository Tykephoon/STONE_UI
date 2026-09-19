/**
 * Mesh generation worker.
 *
 * At subdivision level 6 the generator touches ~82,000 triangles and takes long
 * enough to drop frames if it runs on the main thread. Dragging a slider fires
 * a regeneration on every change, so that would be a visibly janky editor.
 *
 * Buffers are transferred rather than copied, so a multi-megabyte result costs
 * nothing to hand back.
 */
import { type StoneParams, generateStone } from './stone';

export interface GenerateRequest {
  /** Echoed back so a stale result from a superseded request can be discarded. */
  requestId: number;
  params: StoneParams;
}

export interface GenerateSuccess {
  requestId: number;
  ok: true;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  triangleCount: number;
  durationMs: number;
}

export interface GenerateFailure {
  requestId: number;
  ok: false;
  message: string;
}

export type GenerateResponse = GenerateSuccess | GenerateFailure;

self.onmessage = (event: MessageEvent<GenerateRequest>) => {
  const { requestId, params } = event.data;
  const startedAt = performance.now();

  try {
    const mesh = generateStone(params);

    const response: GenerateSuccess = {
      requestId,
      ok: true,
      positions: mesh.positions,
      normals: mesh.normals,
      colors: mesh.colors,
      triangleCount: mesh.triangleCount,
      durationMs: performance.now() - startedAt,
    };

    (self as unknown as Worker).postMessage(response, [
      mesh.positions.buffer,
      mesh.normals.buffer,
      mesh.colors.buffer,
    ]);
  } catch (cause) {
    const response: GenerateFailure = {
      requestId,
      ok: false,
      // The worker's own error text is safe: it describes our generator, not
      // the backend or the user's data.
      message: cause instanceof Error ? cause.message : 'Generation failed.',
    };
    (self as unknown as Worker).postMessage(response);
  }
};
