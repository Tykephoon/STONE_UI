/**
 * Three.js viewport with direct manipulation.
 *
 * Owns the renderer, scene, camera, and orbit controls directly rather than
 * through a React-three binding: the scene is small and fixed, and a reconciler
 * would add a dependency and a layer of indirection for no gain.
 *
 * Three things can be dragged:
 *
 *   - **Control points** on the stone's surface. Pulling one outward raises a
 *     bump, pushing it in presses a dent, and the effect falls off with
 *     distance so it reads as sculpting rather than as moving one vertex.
 *     While dragging, the mesh regenerates at a reduced resolution — level 4
 *     rebuilds in about 10 ms, against 150 ms at level 6 — and the full-detail
 *     mesh is rebuilt once on release.
 *   - **Reference objects** slide along the ground plane.
 *   - **Empty space** orbits the camera, as usual.
 *
 * Rendering is on demand: a frame is drawn when something changes, not sixty
 * times a second into an unchanged picture.
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  type BufferGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { DesignParams } from '../../data/types';
import {
  type ControlHandle,
  MM,
  createControlHandle,
  createReferenceMesh,
  positionControlHandle,
  setControlPull,
} from './sceneHelpers';
import {
  CONTROL_POINT_COUNT,
  CONTROL_POINT_DIRECTIONS,
  MAX_PULL_AMPLITUDE,
  type SculptParams,
} from './controlPoints';
import { type PlacedReference, referenceById } from './referenceObjects';
import styles from './StoneViewer.module.css';

export interface Dimensions {
  length_mm: number;
  width_mm: number;
  height_mm: number;
}

export interface StoneViewerProps {
  geometry: BufferGeometry | null;
  material: DesignParams['material'];
  dimensions: Dimensions;
  /** Reference objects currently placed in the scene. */
  references?: PlacedReference[];
  /** Current sculpt, so handles can be coloured and positioned. */
  sculpt?: SculptParams;
  /** Enables the control points. Off for the read-only viewer. */
  editable?: boolean;
  /** Lets the user hide the dots without losing the sculpt. */
  showControlPoints?: boolean;
  showGrid?: boolean;
  autoRotate?: boolean;
  /** Bumping this re-frames the camera. */
  resetSignal?: number;
  /** Fires continuously while a control point is dragged. */
  onSculptPreview?: (pulls: number[]) => void;
  /** Fires once on release; triggers the full-resolution regeneration. */
  onSculptCommit?: (pulls: number[]) => void;
  /** Fires when a reference object finishes being dragged. */
  onReferenceMoved?: (instanceId: string, x: number, z: number) => void;
  onReferenceSelected?: (instanceId: string | null) => void;
  className?: string;
}

const clampPull = (value: number) => Math.min(1, Math.max(-1, value));

type DragState =
  | {
      kind: 'control';
      handle: ControlHandle;
      origin: Vector3;
      /** Outward radial direction this point is pulled along. */
      axis: Vector3;
      startOffset: number;
      startPull: number;
      /** Scene units that correspond to a pull of 1. */
      unitsPerPull: number;
    }
  | {
      kind: 'reference';
      instanceId: string;
      group: Group;
      grabOffset: Vector3;
    }
  | null;

export function StoneViewer({
  geometry,
  material,
  dimensions,
  sculpt,
  references = [],
  editable = false,
  showControlPoints = true,
  showGrid = true,
  autoRotate = false,
  resetSignal = 0,
  onSculptPreview,
  onSculptCommit,
  onReferenceMoved,
  onReferenceSelected,
  className,
}: StoneViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  const rendererRef = useRef<WebGLRenderer | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const cameraRef = useRef<PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const stoneRef = useRef<Mesh | null>(null);
  const materialRef = useRef<MeshPhysicalMaterial | null>(null);
  const gridRef = useRef<GridHelper | null>(null);
  const frameRef = useRef<number | null>(null);

  const handlesRef = useRef<ControlHandle[]>([]);
  const gizmoGroupRef = useRef<Group | null>(null);
  const referenceGroupRef = useRef<Group | null>(null);
  const referenceHandlesRef = useRef<
    Map<string, { group: Group; pickTarget: Mesh; selectionRing: Mesh; dispose: () => void }>
  >(new Map());

  const dragRef = useRef<DragState>(null);
  const selectedRef = useRef<string | null>(null);
  const dimensionsRef = useRef<Dimensions>(dimensions);
  dimensionsRef.current = dimensions;
  const pullsRef = useRef<number[]>(sculpt?.pulls ?? []);
  pullsRef.current = sculpt?.pulls ?? [];

  // Callbacks in refs so the scene is built once and never torn down by a
  // parent handing down new function identities.
  const previewRef = useRef(onSculptPreview);
  previewRef.current = onSculptPreview;
  const commitRef = useRef(onSculptCommit);
  commitRef.current = onSculptCommit;
  const movedRef = useRef(onReferenceMoved);
  movedRef.current = onReferenceMoved;
  const selectedCallbackRef = useRef(onReferenceSelected);
  selectedCallbackRef.current = onReferenceSelected;

  const requestRender = useRef<() => void>(() => undefined);

  // -------------------------------------------------------------------------
  // Scene setup
  // -------------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = SRGBColorSpace;
    // Filmic tone mapping keeps a wet-looking specular highlight from clipping
    // to a flat white blob.
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.append(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new Scene();
    scene.background = new Color('#0f1114');
    sceneRef.current = scene;

    const camera = new PerspectiveCamera(
      42,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.001,
      100,
    );
    camera.position.set(0.35, 0.24, 0.45);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.8;
    controls.panSpeed = 0.7;
    controls.zoomSpeed = 0.9;
    controls.maxPolarAngle = Math.PI * 0.92;
    controlsRef.current = controls;

    /*
      Three-point rig: a strong key from the upper front, a cool fill from the
      opposite side so the shadow side keeps its form, and a rim from behind to
      separate the silhouette from the background.
    */
    const key = new DirectionalLight('#fff6e8', 2.6);
    key.position.set(1.1, 1.5, 0.9);
    scene.add(key);

    const fill = new DirectionalLight('#9fb6d4', 0.85);
    fill.position.set(-1.2, 0.3, -0.5);
    scene.add(fill);

    const rim = new DirectionalLight('#c8d4e8', 1.1);
    rim.position.set(-0.4, 0.8, -1.4);
    scene.add(rim);

    scene.add(new AmbientLight('#4a5260', 0.55));

    const grid = new GridHelper(1, 20, 0x2c313b, 0x1e222a);
    scene.add(grid);
    gridRef.current = grid;

    const physical = new MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.04,
      clearcoat: 0,
      clearcoatRoughness: 0.4,
    });
    materialRef.current = physical;

    const stone = new Mesh(undefined, physical);
    stone.visible = false;
    scene.add(stone);
    stoneRef.current = stone;

    const gizmoGroup = new Group();
    gizmoGroup.visible = false;
    scene.add(gizmoGroup);
    gizmoGroupRef.current = gizmoGroup;

    const referenceGroup = new Group();
    scene.add(referenceGroup);
    referenceGroupRef.current = referenceGroup;

    const handles: ControlHandle[] = Array.from({ length: CONTROL_POINT_COUNT }, (_, index) =>
      createControlHandle(index),
    );
    for (const handle of handles) gizmoGroup.add(handle.group);
    handlesRef.current = handles;

    let disposed = false;

    const renderFrame = () => {
      frameRef.current = null;
      if (disposed) return;
      controls.update();
      renderer.render(scene, camera);
    };

    requestRender.current = () => {
      if (frameRef.current !== null || disposed) return;
      frameRef.current = requestAnimationFrame(renderFrame);
    };

    controls.addEventListener('change', () => requestRender.current());

    const observer = new ResizeObserver(() => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      requestRender.current();
    });
    observer.observe(container);

    requestRender.current();

    return () => {
      disposed = true;
      observer.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      for (const handle of handles) handle.dispose();
      for (const entry of referenceHandlesRef.current.values()) entry.dispose();
      referenceHandlesRef.current.clear();
      controls.dispose();
      physical.dispose();
      grid.geometry.dispose();
      (grid.material as { dispose: () => void }).dispose();
      renderer.dispose();
      renderer.domElement.remove();
      rendererRef.current = null;
      stoneRef.current = null;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Pointer interaction
  // -------------------------------------------------------------------------
  const pointerToNdc = useCallback((event: PointerEvent): Vector2 | null => {
    const renderer = rendererRef.current;
    if (!renderer) return null;
    const bounds = renderer.domElement.getBoundingClientRect();
    return new Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!renderer || !camera || !controls) return;

    const raycaster = new Raycaster();
    const groundPlane = new Plane(new Vector3(0, 1, 0), 0);
    const dragPlane = new Plane();
    const scratch = new Vector3();

    const pickHandle = (ndc: Vector2): ControlHandle | null => {
      if (!editable || !gizmoGroupRef.current?.visible) return null;

      raycaster.setFromCamera(ndc, camera);

      /*
        Nearest handle wins, not the first in the list. Dots overlap readily
        when the stone is viewed edge-on, and picking whichever happened to be
        created first would grab one behind the surface.
      */
      let closest: ControlHandle | null = null;
      let closestDistance = Number.POSITIVE_INFINITY;

      for (const handle of handlesRef.current) {
        // A hidden group does not hide its children from a direct
        // intersectObject call, so this has to be checked explicitly.
        if (!handle.group.visible) continue;

        const hit = raycaster.intersectObject(handle.pickTarget, false)[0];
        if (hit && hit.distance < closestDistance) {
          closestDistance = hit.distance;
          closest = handle;
        }
      }

      return closest;
    };

    const pickReference = (ndc: Vector2): string | null => {
      raycaster.setFromCamera(ndc, camera);
      for (const [instanceId, entry] of referenceHandlesRef.current) {
        if (raycaster.intersectObject(entry.pickTarget, false).length > 0) return instanceId;
      }
      return null;
    };

    const setSelected = (instanceId: string | null) => {
      if (selectedRef.current === instanceId) return;
      selectedRef.current = instanceId;
      for (const [id, entry] of referenceHandlesRef.current) {
        entry.selectionRing.visible = id === instanceId;
      }
      selectedCallbackRef.current?.(instanceId);
      requestRender.current();
    };

    const onPointerMove = (event: PointerEvent) => {
      const ndc = pointerToNdc(event);
      if (!ndc) return;

      const drag = dragRef.current;

      if (!drag) {
        // Hover feedback only.
        const hovered = pickHandle(ndc);
        let changed = false;
        for (const handle of handlesRef.current) {
          handle.setState(handle === hovered ? 'hover' : 'idle');
          if (handle === hovered) changed = true;
        }
        const overReference = hovered ? null : pickReference(ndc);
        renderer.domElement.style.cursor = hovered
          ? 'grab'
          : overReference
            ? 'grab'
            : '';
        for (const [id, entry] of referenceHandlesRef.current) {
          const visible = id === selectedRef.current || id === overReference;
          if (entry.selectionRing.visible !== visible) {
            entry.selectionRing.visible = visible;
            changed = true;
          }
        }
        if (changed) requestRender.current();
        return;
      }

      raycaster.setFromCamera(ndc, camera);

      if (drag.kind === 'control') {
        const hit = raycaster.ray.intersectPlane(dragPlane, scratch);
        if (!hit) return;

        // How far the pointer has travelled along the point's outward normal.
        const offset = hit.clone().sub(drag.origin).dot(drag.axis);
        const travel = offset - drag.startOffset;

        const next = clampPull(drag.startPull + travel / drag.unitsPerPull);

        const pulls = [...pullsRef.current];
        pulls[drag.handle.index] = next;
        // Keep the ref current so a fast second drag starts from the right place
        // even before React has re-rendered.
        pullsRef.current = pulls;

        setControlPull(drag.handle, next);
        previewRef.current?.(pulls);
        requestRender.current();
        return;
      }

      // Reference objects slide on the ground.
      const hit = raycaster.ray.intersectPlane(groundPlane, scratch);
      if (!hit) return;
      const target = hit.clone().sub(drag.grabOffset);
      drag.group.position.x = target.x;
      drag.group.position.z = target.z;
      requestRender.current();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const ndc = pointerToNdc(event);
      if (!ndc) return;

      const handle = pickHandle(ndc);

      if (handle) {
        raycaster.setFromCamera(ndc, camera);

        const origin = new Vector3();
        handle.group.getWorldPosition(origin);

        // Control points are pulled along their own outward direction.
        const direction = CONTROL_POINT_DIRECTIONS[handle.index]!;
        const axis = new Vector3(direction[0], direction[1], direction[2]).normalize();

        /*
          Drag along a plane that contains the axis and faces the camera as
          squarely as possible. Without this, dragging an axis pointing nearly
          at the viewer produces wild jumps as the ray grazes the plane.
        */
        const viewDirection = camera.getWorldDirection(new Vector3());
        const planeNormal = viewDirection
          .clone()
          .sub(axis.clone().multiplyScalar(viewDirection.dot(axis)))
          .normalize();
        dragPlane.setFromNormalAndCoplanarPoint(planeNormal, origin);

        const hit = raycaster.ray.intersectPlane(dragPlane, new Vector3());
        if (!hit) return;

        /*
          A pull of 1 displaces the surface by MAX_PULL_AMPLITUDE of the base
          radius. The mesh is scaled non-uniformly to the bounding box, so the
          mean half-dimension is the honest single number to convert pointer
          travel into pull.
        */
        const meanHalfExtent =
          ((dimensionsRef.current.length_mm +
            dimensionsRef.current.width_mm +
            dimensionsRef.current.height_mm) /
            6) *
          MM;

        dragRef.current = {
          kind: 'control',
          handle,
          origin,
          axis,
          startOffset: hit.clone().sub(origin).dot(axis),
          startPull: pullsRef.current[handle.index] ?? 0,
          unitsPerPull: Math.max(1e-6, meanHalfExtent * MAX_PULL_AMPLITUDE),
        };

        handle.setState('active');

        controls.enabled = false;
        renderer.domElement.setPointerCapture(event.pointerId);
        renderer.domElement.style.cursor = 'grabbing';
        return;
      }

      const instanceId = pickReference(ndc);

      if (instanceId) {
        const entry = referenceHandlesRef.current.get(instanceId);
        if (!entry) return;

        raycaster.setFromCamera(ndc, camera);
        const hit = raycaster.ray.intersectPlane(groundPlane, new Vector3());
        if (!hit) return;

        setSelected(instanceId);

        dragRef.current = {
          kind: 'reference',
          instanceId,
          group: entry.group,
          // Preserve where within the object the grab happened, so it does not
          // snap its centre to the cursor.
          grabOffset: hit.clone().sub(entry.group.position),
        };

        controls.enabled = false;
        renderer.domElement.setPointerCapture(event.pointerId);
        renderer.domElement.style.cursor = 'grabbing';
        return;
      }

      setSelected(null);
    };

    const onPointerUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      dragRef.current = null;
      controls.enabled = true;
      renderer.domElement.style.cursor = '';
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }

      if (drag.kind === 'control') {
        drag.handle.setState('idle');
        // Commit the pulls accumulated during the drag, not the stale prop —
        // reading the prop here was why the previous gizmo snapped back.
        commitRef.current?.([...pullsRef.current]);
      } else {
        movedRef.current?.(
          drag.instanceId,
          drag.group.position.x / MM,
          drag.group.position.z / MM,
        );
      }

      requestRender.current();
    };

    const element = renderer.domElement;
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);

    return () => {
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
    };
  }, [editable, pointerToNdc]);

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------
  useEffect(() => {
    const stone = stoneRef.current;
    if (!stone) return;

    if (!geometry) {
      stone.visible = false;
      requestRender.current();
      return;
    }

    stone.geometry = geometry;
    stone.visible = true;
    stone.scale.setScalar(MM);

    // Rest the stone on the grid rather than centring it on the origin.
    const box = geometry.boundingBox;
    if (box) stone.position.y = -box.min.y * MM;

    requestRender.current();
  }, [geometry]);

  useEffect(() => {
    const physical = materialRef.current;
    if (!physical) return;

    physical.roughness = material.roughness;
    physical.metalness = material.metalness;
    physical.clearcoat = material.clearcoat;
    physical.clearcoatRoughness = 0.25 + 0.5 * (1 - material.clearcoat);
    physical.needsUpdate = true;

    requestRender.current();
  }, [material]);

  // -------------------------------------------------------------------------
  // Control point placement
  // -------------------------------------------------------------------------
  useEffect(() => {
    const stone = stoneRef.current;
    const gizmoGroup = gizmoGroupRef.current;
    const handles = handlesRef.current;
    if (!stone || !gizmoGroup || handles.length === 0) return;

    const visible = editable && showControlPoints && geometry !== null;
    gizmoGroup.visible = visible;

    if (!visible || !geometry) {
      requestRender.current();
      return;
    }

    // Handles are positioned in world space, so the group itself stays at the
    // origin rather than shadowing the stone's transform.
    gizmoGroup.position.set(0, 0, 0);

    const position = geometry.getAttribute('position');
    const centre = new Vector3();
    stone.getWorldPosition(centre);

    geometry.computeBoundingSphere();
    const reach = (geometry.boundingSphere?.radius ?? 1) * MM * 2;

    const raycaster = new Raycaster();
    const localVertex = new Vector3();
    const worldVertex = new Vector3();

    for (const handle of handles) {
      const direction = CONTROL_POINT_DIRECTIONS[handle.index]!;
      const ray = new Vector3(direction[0], direction[1], direction[2]).normalize();

      /*
        Cast from outside the stone inward, not from the centre outward.
        The material is FrontSide, so a ray starting inside a closed mesh only
        ever meets back faces — which raycasting culls, producing no hit at all.
        Approaching from outside meets the front face the viewer can see.
      */
      raycaster.set(centre.clone().addScaledVector(ray, reach), ray.clone().negate());
      const hit = raycaster.intersectObject(stone, false)[0];

      if (hit?.face) {
        /*
          Snap to the nearest corner of the triangle that was hit, so a dot sits
          exactly on a vertex of the mesh rather than floating at an arbitrary
          point across a face.
        */
        let bestDistance = Number.POSITIVE_INFINITY;
        let bestX = hit.point.x;
        let bestY = hit.point.y;
        let bestZ = hit.point.z;

        for (const vertexIndex of [hit.face.a, hit.face.b, hit.face.c]) {
          localVertex.fromBufferAttribute(position, vertexIndex);
          worldVertex.copy(localVertex);
          stone.localToWorld(worldVertex);

          const distance = worldVertex.distanceToSquared(hit.point);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestX = worldVertex.x;
            bestY = worldVertex.y;
            bestZ = worldVertex.z;
          }
        }

        positionControlHandle(
          handle,
          [bestX, bestY, bestZ],
          // The stone's object scale is uniform, so a local face normal is
          // already a world normal and needs no normal-matrix transform.
          [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z],
        );
        handle.group.visible = true;
      } else {
        // A direction with no hit would otherwise leave a dot stranded in
        // space, which is worse than showing nothing.
        handle.group.visible = false;
      }

      setControlPull(handle, pullsRef.current[handle.index] ?? 0);
    }

    requestRender.current();
  }, [geometry, editable, showControlPoints, dimensions, sculpt]);

  // -------------------------------------------------------------------------
  // Reference objects
  // -------------------------------------------------------------------------
  useEffect(() => {
    const group = referenceGroupRef.current;
    if (!group) return;

    const current = referenceHandlesRef.current;
    const wanted = new Set(references.map((entry) => entry.instanceId));

    // Remove anything no longer placed.
    for (const [instanceId, entry] of current) {
      if (wanted.has(instanceId)) continue;
      group.remove(entry.group);
      entry.dispose();
      current.delete(instanceId);
    }

    // Add or reposition the rest.
    for (const placed of references) {
      const definition = referenceById(placed.objectId);
      if (!definition) continue;

      let entry = current.get(placed.instanceId);

      if (!entry) {
        const created = createReferenceMesh(definition, definition.name);
        group.add(created.group);
        entry = created;
        current.set(placed.instanceId, created);
      }

      entry.group.position.set(placed.x * MM, 0, placed.z * MM);
      entry.selectionRing.visible = placed.instanceId === selectedRef.current;
    }

    requestRender.current();
  }, [references]);

  // -------------------------------------------------------------------------
  // Framing and grid
  // -------------------------------------------------------------------------
  useEffect(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const scene = sceneRef.current;
    if (!camera || !controls || !scene) return;

    // Frame everything in the scene, not just the stone, so adding a person
    // does not leave it off screen.
    const referenceReach = references.reduce((furthest, placed) => {
      const definition = referenceById(placed.objectId);
      const extent = Math.hypot(placed.x, placed.z) + (definition?.length ?? 0) / 2;
      return Math.max(furthest, extent);
    }, 0);

    const sceneExtentMm = Math.max(
      dimensions.length_mm,
      dimensions.width_mm,
      dimensions.height_mm,
      referenceReach * 2,
    );
    const sizeMetres = Math.max(0.01, sceneExtentMm * MM);
    // 2.4× the largest extent leaves the subject comfortably inside a 42° frame
    // without it swimming in empty space.
    const distance = sizeMetres * 2.4;

    camera.position.set(distance * 0.62, distance * 0.48, distance * 0.78);
    camera.near = Math.max(0.0005, sizeMetres / 200);
    camera.far = distance * 40;
    camera.updateProjectionMatrix();

    controls.target.set(0, (dimensions.height_mm * MM) / 2, 0);
    controls.minDistance = sizeMetres * 0.2;
    controls.maxDistance = sizeMetres * 20;
    controls.update();

    const previous = gridRef.current;
    if (previous) {
      scene.remove(previous);
      previous.geometry.dispose();
      (previous.material as { dispose: () => void }).dispose();
    }

    // A 10 mm grid up to a sensible count, so squares read as a real unit.
    const gridSize = sizeMetres * 4;
    const divisions = Math.min(80, Math.max(10, Math.round(gridSize / (0.01 * MM * 1000))));
    const grid = new GridHelper(gridSize, divisions, 0x2c313b, 0x1e222a);
    grid.visible = showGrid;
    scene.add(grid);
    gridRef.current = grid;

    requestRender.current();
    // Re-frames only on an explicit reset or a change of scene contents, not on
    // every dimension tweak, which would fight the user mid-drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal, references.length, showGrid]);

  useEffect(() => {
    if (gridRef.current) {
      gridRef.current.visible = showGrid;
      requestRender.current();
    }
  }, [showGrid]);

  // -------------------------------------------------------------------------
  // Auto-rotate
  // -------------------------------------------------------------------------
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 1.1;

    if (!autoRotate) return;

    let handle = 0;
    const tick = () => {
      // Pause while dragging, or the scene slides out from under the cursor.
      if (!dragRef.current) {
        controls.update();
        const renderer = rendererRef.current;
        const scene = sceneRef.current;
        const camera = cameraRef.current;
        if (renderer && scene && camera) renderer.render(scene, camera);
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(handle);
  }, [autoRotate]);

  return (
    <div
      ref={containerRef}
      className={[styles.viewport, className ?? ''].filter(Boolean).join(' ')}
      role="img"
      aria-label={
        editable
          ? 'Interactive 3D preview. Drag the coloured arrows to stretch the stone, drag reference objects to move them, drag elsewhere to orbit.'
          : 'Interactive 3D preview of the generated stone. Drag to orbit, scroll to zoom.'
      }
    />
  );
}

export { MM };
