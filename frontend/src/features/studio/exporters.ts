/**
 * Mesh export and link sharing.
 *
 * Two kinds of "export" are offered and they are not the same thing:
 *
 *   - glTF / OBJ download: a baked mesh, for a renderer or a slicer.
 *   - encoded URL: the *parameters*, not the mesh. A few hundred characters
 *     that regenerate the identical stone, because generation is deterministic.
 */
import type { BufferGeometry } from 'three';
import { Mesh, MeshStandardMaterial } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import type { DesignParams } from '../../data/types';
import { sanitiseParams } from './types';

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Filesystem-safe name derived from the design's title. */
function safeFilename(name: string, extension: string): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'stone';
  return `${base}.${extension}`;
}

/**
 * Build a throwaway mesh for the exporters.
 *
 * The viewer's own mesh is scaled to metres and offset to sit on the grid;
 * exporting that would bake the presentation transform into the file. This
 * builds an untransformed copy so the exported model is in millimetres at the
 * origin, which is what a CAD or printing pipeline expects.
 */
function buildExportMesh(
  geometry: BufferGeometry,
  params: DesignParams,
): { mesh: Mesh; material: MeshStandardMaterial } {
  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: params.material.roughness,
    metalness: params.material.metalness,
  });
  // The material is returned alongside the mesh because `Mesh.material` is
  // typed as `Material | Material[]`, which has no `dispose` in common.
  return { mesh: new Mesh(geometry, material), material };
}

export async function exportGltf(
  geometry: BufferGeometry,
  params: DesignParams,
  name: string,
): Promise<void> {
  const { mesh, material } = buildExportMesh(geometry, params);
  const exporter = new GLTFExporter();

  const result = await exporter.parseAsync(mesh, { binary: true });
  material.dispose();

  // `binary: true` yields an ArrayBuffer (.glb); the JSON path yields an object.
  if (result instanceof ArrayBuffer) {
    triggerDownload(
      new Blob([result], { type: 'model/gltf-binary' }),
      safeFilename(name, 'glb'),
    );
    return;
  }

  triggerDownload(
    new Blob([JSON.stringify(result)], { type: 'model/gltf+json' }),
    safeFilename(name, 'gltf'),
  );
}

export function exportObj(geometry: BufferGeometry, params: DesignParams, name: string): void {
  const { mesh, material } = buildExportMesh(geometry, params);
  const text = new OBJExporter().parse(mesh);
  material.dispose();

  triggerDownload(new Blob([text], { type: 'model/obj' }), safeFilename(name, 'obj'));
}

// ---------------------------------------------------------------------------
// Parameter links
// ---------------------------------------------------------------------------

/**
 * Base64url without padding — safe in a URL fragment with no escaping.
 */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Pack parameters into a URL fragment.
 *
 * Numbers are rounded before encoding: three decimal places is far finer than
 * any slider step, and full float precision would triple the link length for
 * digits nobody can perceive.
 */
export function encodeParams(params: DesignParams, name: string): string {
  const round = (value: number, places = 3) => Number(value.toFixed(places));

  const compact = {
    v: 1,
    n: name.slice(0, 80),
    s: params.seed,
    d: [
      round(params.dimensions.length_mm, 1),
      round(params.dimensions.width_mm, 1),
      round(params.dimensions.height_mm, 1),
    ],
    f: [
      round(params.form.roundness),
      round(params.form.taper),
      round(params.form.asymmetry),
      round(params.form.flatten),
      round(params.form.bulge),
    ],
    u: [
      round(params.surface.detail),
      round(params.surface.grain),
      round(params.surface.erosion),
      round(params.surface.faceting),
      params.surface.resolution,
    ],
    m: [
      params.material.color,
      params.material.accentColor,
      round(params.material.roughness),
      round(params.material.metalness),
      round(params.material.speckle),
      round(params.material.clearcoat),
    ],
  };

  return toBase64Url(JSON.stringify(compact));
}

export interface DecodedParams {
  params: DesignParams;
  name: string;
}

/**
 * Unpack a link.
 *
 * Returns null on anything malformed rather than throwing: this input comes
 * from a URL a stranger may have edited, and the caller's job is to fall back
 * to defaults, not to crash.
 */
export function decodeParams(encoded: string): DecodedParams | null {
  try {
    const parsed = JSON.parse(fromBase64Url(encoded)) as Record<string, unknown>;
    if (parsed.v !== 1) return null;

    const d = parsed.d as number[] | undefined;
    const f = parsed.f as number[] | undefined;
    const u = parsed.u as number[] | undefined;
    const m = parsed.m as (string | number)[] | undefined;
    if (!d || !f || !u || !m) return null;

    // sanitiseParams clamps every field, so a hostile link cannot produce a
    // 10-million-triangle mesh or a negative dimension.
    const params = sanitiseParams({
      seed: parsed.s,
      dimensions: { length_mm: d[0], width_mm: d[1], height_mm: d[2] },
      form: {
        roundness: f[0],
        taper: f[1],
        asymmetry: f[2],
        flatten: f[3],
        bulge: f[4],
      },
      surface: {
        detail: u[0],
        grain: u[1],
        erosion: u[2],
        faceting: u[3],
        resolution: u[4],
      },
      material: {
        color: m[0],
        accentColor: m[1],
        roughness: m[2],
        metalness: m[3],
        speckle: m[4],
        clearcoat: m[5],
      },
    });

    const name = typeof parsed.n === 'string' && parsed.n.trim() ? parsed.n.trim() : 'Shared stone';

    return { params, name };
  } catch {
    return null;
  }
}

/** Absolute link that reopens the editor with these parameters loaded. */
export function buildParameterLink(params: DesignParams, name: string): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#/studio?d=${encodeParams(params, name)}`;
}

/**
 * Absolute link to the read-only viewer.
 *
 * Carries the same encoded parameters as the editable link, so it works with no
 * server and cannot be revoked — the design travels in the URL.
 */
export function buildViewerLink(params: DesignParams, name: string): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#/shared/${encodeParams(params, name)}`;
}
