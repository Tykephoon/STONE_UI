/**
 * Scene construction helpers: reference-object meshes, their labels, and the
 * stretch gizmo.
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
  ConeGeometry,
  CylinderGeometry as ShaftGeometry,
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
// Stretch gizmo
// ---------------------------------------------------------------------------

export type StretchAxis = 'length' | 'width' | 'height';

export interface StretchHandle {
  group: Group;
  pickTarget: Mesh;
  axis: StretchAxis;
  /** +1 or −1: which end of the axis this handle sits on. */
  direction: number;
  setHighlighted: (value: boolean) => void;
  dispose: () => void;
}

/**
 * Axis colours follow the near-universal X=red, Y=green, Z=blue convention.
 *
 * This is the one place the app deliberately ignores its own palette: anyone
 * who has used a 3D tool reads these colours as axes instantly, and inventing a
 * house scheme would trade that recognition for nothing.
 */
const AXIS_COLOR: Record<StretchAxis, number> = {
  length: 0xe05252, // X
  height: 0x4caf50, // Y
  width: 0x4a8fe0, // Z
};

export function createStretchHandle(axis: StretchAxis, direction: number): StretchHandle {
  const group = new Group();
  const color = AXIS_COLOR[axis];

  const shaftLength = 0.03;
  const material = new MeshBasicMaterial({ color, depthTest: false, transparent: true });

  const shaftGeometry = new ShaftGeometry(0.0016, 0.0016, shaftLength, 12);
  const shaft = new Mesh(shaftGeometry, material);
  shaft.position.y = shaftLength / 2;
  group.add(shaft);

  const coneGeometry = new ConeGeometry(0.0055, 0.014, 16);
  const cone = new Mesh(coneGeometry, material);
  cone.position.y = shaftLength + 0.007;
  group.add(cone);

  /*
    An invisible cylinder covering the whole handle is what pointer events
    actually test against. The drawn arrow is a few millimetres across on
    screen; hitting that exactly would be unreasonable, so the hit volume is
    deliberately far larger than the visible mark.
  */
  const pickGeometry = new ShaftGeometry(0.011, 0.011, shaftLength + 0.02, 8);
  const pickTarget = new Mesh(
    pickGeometry,
    new MeshBasicMaterial({ visible: false, depthTest: false }),
  );
  pickTarget.position.y = (shaftLength + 0.02) / 2;
  group.add(pickTarget);

  // Gizmos draw over the model so they are never lost inside it.
  group.renderOrder = 1000;
  for (const child of group.children) child.renderOrder = 1000;

  return {
    group,
    pickTarget,
    axis,
    direction,
    setHighlighted: (value: boolean) => {
      material.color.setHex(value ? 0xffffff : color);
    },
    dispose: () => {
      shaftGeometry.dispose();
      coneGeometry.dispose();
      pickGeometry.dispose();
      material.dispose();
      (pickTarget.material as MeshBasicMaterial).dispose();
    },
  };
}

/**
 * Orient a handle along its axis and place it at the surface of the bounding
 * box, offset outward so it does not intersect the mesh.
 */
export function positionStretchHandle(
  handle: StretchHandle,
  dimensions: { length_mm: number; width_mm: number; height_mm: number },
): void {
  const { group, axis, direction } = handle;
  const gap = 0.012;

  group.rotation.set(0, 0, 0);

  if (axis === 'length') {
    // Arrows point along +X or −X; the handle is modelled pointing up (+Y).
    group.rotation.z = direction > 0 ? -Math.PI / 2 : Math.PI / 2;
    group.position.set(
      direction * ((dimensions.length_mm / 2) * MM + gap),
      (dimensions.height_mm / 2) * MM,
      0,
    );
  } else if (axis === 'width') {
    group.rotation.x = direction > 0 ? Math.PI / 2 : -Math.PI / 2;
    group.position.set(
      0,
      (dimensions.height_mm / 2) * MM,
      direction * ((dimensions.width_mm / 2) * MM + gap),
    );
  } else {
    // Height grows upward from the ground, so there is only a +Y handle.
    group.position.set(0, dimensions.height_mm * MM + gap, 0);
  }
}

/** World-space unit vector a handle drags along. */
export function axisVector(axis: StretchAxis): [number, number, number] {
  if (axis === 'length') return [1, 0, 0];
  if (axis === 'width') return [0, 0, 1];
  return [0, 1, 0];
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
