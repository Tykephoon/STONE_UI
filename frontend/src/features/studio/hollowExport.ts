/**
 * Turning a design into the files a printer actually needs.
 *
 * A hollow stone is two prints, not one: the shell and the base that closes it.
 * They are written as separate STLs because they are separate objects on the
 * plate, printed in different orientations, and a single file would force the
 * user to pull them apart in the slicer.
 */
import type { BufferGeometry } from 'three';
import { buildStlFromPositions } from './printing';
import { triggerDownload, safeFilename } from './exporters';
import { buildHollowShell, type HollowResult } from './hollow';
import {
  type SupportPost,
  buildBase,
  buildSupportPost,
  ceilingHeightAt,
  pointInLoop,
} from './baseAndSupports';
import { FIT_PRESETS, type FitId } from './baseAndSupports';

export interface HollowExportSettings {
  wallThickness: number;
  openingHeight: number;
  fit: FitId;
  plugDepth: number;
  supports: SupportPost[];
}

export interface HollowBuild {
  shell: HollowResult;
  /** Shell plus support posts, ready to write. */
  shellWithSupports: Float32Array;
  base: { positions: Float32Array; size: { length: number; width: number; height: number } } | null;
  /** Posts that were dropped because there was no cavity above them. */
  droppedSupports: number;
}

/** Floor thickness of the base. Enough to be rigid without wasting height. */
const FLOOR_THICKNESS = 2.5;

/**
 * Lower the solid onto y = 0.
 *
 * The generator centres its output; the printer wants it resting on the plate,
 * and every height in the hollow settings is measured from there.
 */
export function restOnPlate(positions: Float32Array): Float32Array {
  const lowered = new Float32Array(positions);

  let minY = Number.POSITIVE_INFINITY;
  for (let i = 1; i < lowered.length; i += 3) {
    if (lowered[i]! < minY) minY = lowered[i]!;
  }
  for (let i = 1; i < lowered.length; i += 3) {
    lowered[i] = lowered[i]! - minY;
  }

  return lowered;
}

/**
 * Hollow the shape, and nothing else.
 *
 * Split out from the assembly below because it is the expensive half — it
 * walks every triangle twice and clips the whole mesh — and because it depends
 * on none of the things the user changes most often. Dragging a support post
 * or loosening the base fit must not re-hollow the stone.
 */
export function buildShellFor(
  geometry: BufferGeometry,
  settings: Pick<HollowExportSettings, 'wallThickness' | 'openingHeight'>,
): HollowResult {
  return buildHollowShell(restOnPlate(geometry.getAttribute('position').array as Float32Array), {
    wallThickness: settings.wallThickness,
    openingHeight: settings.openingHeight,
  });
}

/** Add the posts and the base to an already-hollowed shell. */
export function assembleHollowParts(
  shell: HollowResult,
  settings: Pick<HollowExportSettings, 'fit' | 'plugDepth' | 'supports'>,
): HollowBuild {
  // Nothing to add to, and nothing to close: the caller falls back to the solid.
  if (!shell.feasible) {
    return {
      shell,
      shellWithSupports: shell.positions,
      base: null,
      droppedSupports: settings.supports.length,
    };
  }

  const planeY = shell.cutPlaneY;

  const combined: number[] = Array.from(shell.positions);
  let dropped = 0;

  for (const post of settings.supports) {
    // A post outside the cavity would sit in the wall or in mid-air.
    if (!pointInLoop(shell.innerLoop.points, post.x, post.z)) {
      dropped += 1;
      continue;
    }

    const ceiling = ceilingHeightAt(shell.positions, post.x, post.z, planeY);
    if (ceiling === null) {
      dropped += 1;
      continue;
    }

    const triangles = buildSupportPost(post, planeY, ceiling);
    if (triangles.length === 0) {
      dropped += 1;
      continue;
    }

    combined.push(...triangles);
  }

  const clearance =
    FIT_PRESETS.find((entry) => entry.id === settings.fit)?.clearance ?? 0.2;

  const base = buildBase(shell.outerLoop, shell.innerLoop, {
    clearance,
    plugDepth: settings.plugDepth,
    floorThickness: FLOOR_THICKNESS,
  });

  return {
    shell,
    shellWithSupports: new Float32Array(combined),
    base: { positions: base.positions, size: base.size },
    droppedSupports: dropped,
  };
}

/** Hollow and assemble in one step. */
export function buildHollowParts(
  geometry: BufferGeometry,
  settings: HollowExportSettings,
): HollowBuild {
  return assembleHollowParts(buildShellFor(geometry, settings), settings);
}

export interface ExportedFiles {
  shellName: string;
  baseName: string | null;
}

/** Write the shell and, when there is one, the base. */
export function exportHollowStl(build: HollowBuild, name: string): ExportedFiles {
  const shellName = safeFilename(`${name} shell`, 'stl');

  triggerDownload(
    new Blob([buildStlFromPositions(build.shellWithSupports, `${name} shell`)], {
      type: 'model/stl',
    }),
    shellName,
  );

  if (!build.base) return { shellName, baseName: null };

  const baseName = safeFilename(`${name} base`, 'stl');

  // Staggered, because two downloads fired in the same tick are silently
  // collapsed to one by several browsers.
  setTimeout(() => {
    triggerDownload(
      new Blob([buildStlFromPositions(build.base!.positions, `${name} base`)], {
        type: 'model/stl',
      }),
      baseName,
    );
  }, 350);

  return { shellName, baseName };
}
