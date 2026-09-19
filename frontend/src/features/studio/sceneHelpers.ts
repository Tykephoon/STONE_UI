/**
 * Scene construction helpers: reference-object meshes, their labels, and the
 * surface control points.
 *
 * Kept out of the viewer so that file is about interaction rather than about
 * building geometry.
 *
 * Everything here works in millimetres and is scaled to scene units by the
 * caller, so the numbers in this file match the numbers in
 * `referenceObjects.ts` and can be checked against them directly.
 */
import {
  BoxGeometry,
  CanvasTexture,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  RingGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import type { ReferenceObject } from './referenceObjects';

/** Scene works in metres; the model is authored in millimetres. */
export const MM = 0.001;

// ---------------------------------------------------------------------------
// Reference objects
// ---------------------------------------------------------------------------

function geometryFor(object: ReferenceObject) {
  const l = object.length * MM;
  const w = object.width * MM;
  const h = object.height * MM;

  switch (object.shape) {
    case 'cylinder':
      // Radial segments scale with size so a coin does not look faceted while
      // a can does not waste triangles.
      return new CylinderGeometry(l / 2, l / 2, h, 48);
    case 'sphere':
      return new SphereGeometry(l / 2, 32, 24);
    case 'capsule':
      // A capsule's `height` argument is the cylindrical section only.
      return new CapsuleGeometry(l / 2, Math.max(0.001, h - l), 12, 24);
    default:
      return new BoxGeometry(l, h, w);
  }
}

/**
 * Text label that always faces the camera.
 *
 * A canvas sprite rather than CSS2DRenderer: it needs no second render pass and
 * no DOM overlay to keep in sync with the canvas.
 */
function createLabel(text: string): Sprite {
  const scale = 2; // Render at 2× and downsample, so it stays crisp.
  const font = `${13 * scale}px ui-sans-serif, system-ui, sans-serif`;

  const measure = document.createElement('canvas').getContext('2d');
  if (measure) measure.font = font;
  const textWidth = measure?.measureText(text).width ?? text.length * 8 * scale;

  const paddingX = 10 * scale;
  const paddingY = 6 * scale;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(textWidth + paddingX * 2);
  canvas.height = Math.ceil(18 * scale + paddingY * 2);

  const context = canvas.getContext('2d');
  if (context) {
    const radius = 6 * scale;
    context.fillStyle = 'rgba(27, 30, 37, 0.92)';
    context.beginPath();
    context.roundRect(0, 0, canvas.width, canvas.height, radius);
    context.fill();

    context.strokeStyle = 'rgba(58, 64, 76, 0.9)';
    context.lineWidth = scale;
    context.stroke();

    context.font = font;
    context.fillStyle = '#e8e6e1';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, canvas.width / 2, canvas.height / 2);
  }

  const texture = new CanvasTexture(canvas);
  const sprite = new Sprite(
    new SpriteMaterial({ map: texture, depthTest: false, transparent: true }),
  );

  // Sized in world units so labels stay legible without tracking zoom.
  const worldHeight = 0.018;
  sprite.scale.set((canvas.width / canvas.height) * worldHeight, worldHeight, 1);
  // Draw above everything, so a label is never buried inside its own object.
  sprite.renderOrder = 999;

  return sprite;
}

export interface ReferenceHandle {
  group: Group;
  /** The mesh that pointer events test against. */
  pickTarget: Mesh;
  selectionRing: Mesh;
  dispose: () => void;
}

export function createReferenceMesh(object: ReferenceObject, label: string): ReferenceHandle {
  const group = new Group();

  const geometry = geometryFor(object);
  const material = new MeshStandardMaterial({
    color: new Color(object.color),
    roughness: 0.62,
    metalness: 0.05,
    transparent: true,
    // Slightly translucent so a reference never visually competes with the
    // stone it exists to measure.
    opacity: 0.82,
  });

  const mesh = new Mesh(geometry, material);

  // Sit the object on the ground rather than centred on it.
  const height = object.shape === 'capsule' ? object.height : object.height;
  mesh.position.y = (height * MM) / 2;
  group.add(mesh);

  // Selection ring on the floor, hidden until hover or selection.
  const ringRadius = (Math.max(object.length, object.width) * MM) / 2 + 0.006;
  const selectionRing = new Mesh(
    new RingGeometry(ringRadius, ringRadius + 0.0035, 48),
    new MeshBasicMaterial({ color: 0x3987e5, side: DoubleSide, transparent: true, opacity: 0.9 }),
  );
  selectionRing.rotation.x = -Math.PI / 2;
  selectionRing.position.y = 0.0004;
  selectionRing.visible = false;
  group.add(selectionRing);

  const sprite = createLabel(label);
  sprite.position.y = height * MM + 0.022;
  group.add(sprite);

  return {
    group,
    pickTarget: mesh,
    selectionRing,
    dispose: () => {
      geometry.dispose();
      material.dispose();
      selectionRing.geometry.dispose();
      (selectionRing.material as MeshBasicMaterial).dispose();
      sprite.material.map?.dispose();
      sprite.material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Surface control points
// ---------------------------------------------------------------------------

export interface ControlHandle {
  group: Group;
  /** Invisible sphere that pointer events test against. */
  pickTarget: Mesh;
  index: number;
  setState: (state: 'idle' | 'hover' | 'active') => void;
  /** Applies the distance-compensating scale computed each frame. */
  setScreenScale: (scale: number) => void;
  dispose: () => void;
}

/** Neutral, pulled out, pushed in. Colour carries the sign of the pull. */
const DOT_NEUTRAL = 0xd8d2c4;
const DOT_OUT = 0x4caf50;
const DOT_IN = 0xe05252;

/**
 * Geometry is built at unit radius and sized entirely by `setScreenScale`, so a
 * dot stays the same size on screen whether the stone is a pebble or a boulder
 * and whether the camera is close or far. A fixed world size would be
 * unusable at one end of that range and invisible at the other.
 */
const DOT_RADIUS = 1;
const RING_INNER = 1.9;
const RING_OUTER = 2.45;
const PICK_RADIUS = 3.4;

/**
 * A control point: a small bead sitting on a vertex, with a ring that appears
 * on hover to show the area a pull will affect.
 *
 * Both are depth-tested, so the rock hides the ones behind it. The bead is
 * centred on the surface rather than floating above it, which means the rock
 * clips its back half — it reads as set into the stone, and a sphere
 * intersecting a surface cannot z-fight the way a floating one would.
 */
export function createControlHandle(index: number): ControlHandle {
  const group = new Group();

  const dotMaterial = new MeshBasicMaterial({
    color: DOT_NEUTRAL,
    transparent: true,
    opacity: 0.98,
  });
  const dotGeometry = new SphereGeometry(DOT_RADIUS, 16, 12);
  const dot = new Mesh(dotGeometry, dotMaterial);
  group.add(dot);

  const ringMaterial = new MeshBasicMaterial({
    color: 0x3987e5,
    side: DoubleSide,
    transparent: true,
    opacity: 0,
    /*
      The ring lies flat against the surface, so it is coplanar with the
      triangles under it and would shimmer. A polygon offset pulls it toward
      the camera in depth only, without moving it in space.
    */
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const ringGeometry = new RingGeometry(RING_INNER, RING_OUTER, 32);
  const ring = new Mesh(ringGeometry, ringMaterial);
  group.add(ring);

  // A generous invisible target: the bead is a few pixels across, and
  // requiring a pixel-perfect hit would make the tool feel broken.
  const pickGeometry = new SphereGeometry(PICK_RADIUS, 12, 8);
  const pickTarget = new Mesh(pickGeometry, new MeshBasicMaterial({ visible: false }));
  group.add(pickTarget);

  let stateScale = 1;
  let screenScale = 1;
  const applyScale = () => group.scale.setScalar(stateScale * screenScale);

  return {
    group,
    pickTarget,
    index,
    setState: (state) => {
      stateScale = state === 'idle' ? 1 : state === 'hover' ? 1.3 : 1.5;
      ringMaterial.opacity = state === 'idle' ? 0 : state === 'hover' ? 0.6 : 0.95;
      applyScale();
    },
    setScreenScale: (scale) => {
      screenScale = scale;
      applyScale();
    },
    dispose: () => {
      dotGeometry.dispose();
      dotMaterial.dispose();
      ringGeometry.dispose();
      ringMaterial.dispose();
      pickGeometry.dispose();
      (pickTarget.material as MeshBasicMaterial).dispose();
    },
  };
}

/** Tint a dot by the sign and size of its pull, so the sculpt reads at a glance. */
export function setControlPull(handle: ControlHandle, pull: number): void {
  const dot = handle.group.children[0] as Mesh;
  const material = dot.material as MeshBasicMaterial;

  if (Math.abs(pull) < 0.02) {
    material.color.setHex(DOT_NEUTRAL);
    return;
  }

  const target = new Color(pull > 0 ? DOT_OUT : DOT_IN);
  // Blend toward the extreme so a gentle pull is visibly gentler than a hard one.
  material.color.set(new Color(DOT_NEUTRAL).lerp(target, Math.min(1, Math.abs(pull) * 1.6)));
}

/**
 * Screen-constant sizing.
 *
 * Multiplying by distance cancels perspective foreshortening, so the bead keeps
 * a steady pixel size. The constant is derived from the viewport's vertical
 * field of view rather than guessed, so it holds if the camera changes.
 */
export function screenScaleFor(distance: number, fovRadians: number, targetFraction = 0.009): number {
  const worldHeightAtDistance = 2 * distance * Math.tan(fovRadians / 2);
  return worldHeightAtDistance * targetFraction;
}

/**
 * Place a handle on the surface and turn its ring to lie flat against it.
 *
 * `surfacePoint` is a world position on the mesh, so the bead sits on the rock
 * rather than near it.
 */
export function positionControlHandle(
  handle: ControlHandle,
  surfacePoint: [number, number, number],
  normal: [number, number, number],
): void {
  handle.group.position.set(surfacePoint[0], surfacePoint[1], surfacePoint[2]);

  // Lay the ring flat against the surface: its default plane faces +Z.
  const target = new Vector3(normal[0], normal[1], normal[2]).normalize();
  const ring = handle.group.children[1] as Mesh;
  ring.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), target);
}

export function disposeObject(object: Object3D): void {
  object.traverse((child) => {
    if (child instanceof Mesh) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) {
        for (const entry of material) entry.dispose();
      } else {
        material.dispose();
      }
    }
  });
}
