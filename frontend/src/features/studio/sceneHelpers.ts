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
  dispose: () => void;
}

/** Neutral, pulled out, pushed in. Colour carries the sign of the pull. */
const DOT_NEUTRAL = 0xc9c3b6;
const DOT_OUT = 0x4caf50;
const DOT_IN = 0xe05252;

/**
 * A control point: a small dot on the surface, with a ring that appears on
 * hover to show the area a pull will affect.
 *
 * Both draw over the stone. A handle hidden inside the geometry it controls is
 * a handle nobody can use.
 */
export function createControlHandle(index: number): ControlHandle {
  const group = new Group();

  const dotMaterial = new MeshBasicMaterial({
    color: DOT_NEUTRAL,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });
  const dotGeometry = new SphereGeometry(0.0038, 16, 12);
  const dot = new Mesh(dotGeometry, dotMaterial);
  group.add(dot);

  const ringMaterial = new MeshBasicMaterial({
    color: 0x3987e5,
    side: DoubleSide,
    depthTest: false,
    transparent: true,
    opacity: 0,
  });
  const ringGeometry = new RingGeometry(0.0072, 0.0092, 32);
  const ring = new Mesh(ringGeometry, ringMaterial);
  group.add(ring);

  // A generous invisible target: the dot is a few pixels across on screen, and
  // requiring a pixel-perfect hit would make the tool feel broken.
  const pickGeometry = new SphereGeometry(0.014, 12, 8);
  const pickTarget = new Mesh(
    pickGeometry,
    new MeshBasicMaterial({ visible: false, depthTest: false }),
  );
  group.add(pickTarget);

  group.renderOrder = 1000;
  dot.renderOrder = 1001;
  ring.renderOrder = 1000;

  return {
    group,
    pickTarget,
    index,
    setState: (state) => {
      const scale = state === 'idle' ? 1 : state === 'hover' ? 1.35 : 1.6;
      dot.scale.setScalar(scale);
      ringMaterial.opacity = state === 'idle' ? 0 : state === 'hover' ? 0.55 : 0.9;
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
 * Place a handle on the deformed surface and turn its ring to face outward.
 *
 * `surfacePoint` is in scene units and already includes the sculpt, so the dot
 * sits on the stone rather than hovering off a notional sphere.
 */
export function positionControlHandle(
  handle: ControlHandle,
  surfacePoint: [number, number, number],
  normal: [number, number, number],
): void {
  handle.group.position.set(surfacePoint[0], surfacePoint[1], surfacePoint[2]);

  // Lay the ring flat against the surface: its default plane faces +Z.
  const target = new Vector3(normal[0], normal[1], normal[2]);
  const ring = handle.group.children[1] as Mesh;
  ring.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), target.normalize());
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
