/**
 * Three.js viewport.
 *
 * Owns the renderer, scene, camera, and orbit controls directly rather than
 * through a React-three binding: the scene has one mesh and a fixed light rig,
 * and a reconciler would add a dependency and a layer of indirection for no
 * gain.
 *
 * Rendering is on demand — a frame is drawn when the camera moves or the
 * geometry changes, not sixty times a second into an unchanged picture.
 */
import { useEffect, useRef } from 'react';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  type BufferGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Mesh,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { DesignParams } from '../../data/types';
import styles from './StoneViewer.module.css';

export interface StoneViewerProps {
  geometry: BufferGeometry | null;
  material: DesignParams['material'];
  /** Longest dimension in millimetres, used to frame the camera. */
  scaleHint: number;
  showGrid?: boolean;
  autoRotate?: boolean;
  /** Bumping this value re-frames the camera on the stone. */
  resetSignal?: number;
  className?: string;
}

/** The scene works in metres; the model is authored in millimetres. */
const MM_TO_SCENE = 0.001;

export function StoneViewer({
  geometry,
  material,
  scaleHint,
  showGrid = true,
  autoRotate = false,
  resetSignal = 0,
  className,
}: StoneViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  const rendererRef = useRef<WebGLRenderer | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const cameraRef = useRef<PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshRef = useRef<Mesh | null>(null);
  const materialRef = useRef<MeshPhysicalMaterial | null>(null);
  const gridRef = useRef<GridHelper | null>(null);
  const frameRef = useRef<number | null>(null);

  /** Queue exactly one frame; repeated calls in a tick collapse to one draw. */
  const requestRender = useRef<() => void>(() => undefined);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = SRGBColorSpace;
    // Filmic tone mapping keeps the specular highlight on a wet-looking stone
    // from clipping to a flat white blob.
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
    // Stop the orbit from passing under the ground plane, which looks broken.
    controls.maxPolarAngle = Math.PI * 0.92;
    controlsRef.current = controls;

    /*
      A three-point rig: a strong key from the upper front, a cool fill from
      the opposite side so the shadow side keeps some form, and a rim light
      from behind to separate the silhouette from the background.
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
    grid.position.y = 0;
    scene.add(grid);
    gridRef.current = grid;

    const physicalMaterial = new MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.04,
      clearcoat: 0,
      clearcoatRoughness: 0.4,
      // Flat-shaded triangles come from the generator's normals, not from
      // three's flatShading, so smooth-to-faceted can be continuous.
      flatShading: false,
    });
    materialRef.current = physicalMaterial;

    const mesh = new Mesh(undefined, physicalMaterial);
    mesh.visible = false;
    scene.add(mesh);
    meshRef.current = mesh;

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
      controls.dispose();
      physicalMaterial.dispose();
      grid.geometry.dispose();
      (grid.material as { dispose: () => void }).dispose();
      renderer.dispose();
      renderer.domElement.remove();
      rendererRef.current = null;
      meshRef.current = null;
    };
  }, []);

  /** Continuous rotation, only while it is switched on. */
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 1.1;

    if (!autoRotate) return;

    let handle = 0;
    const tick = () => {
      controls.update();
      rendererRef.current?.render(sceneRef.current!, cameraRef.current!);
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(handle);
  }, [autoRotate]);

  /** Swap in new geometry. */
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    if (!geometry) {
      mesh.visible = false;
      requestRender.current();
      return;
    }

    mesh.geometry = geometry;
    mesh.visible = true;

    // Author units are millimetres; the scene is metres.
    mesh.scale.setScalar(MM_TO_SCENE);

    // Rest the stone on the grid rather than centring it on the origin.
    const box = geometry.boundingBox;
    if (box) {
      mesh.position.y = -box.min.y * MM_TO_SCENE;
    }

    requestRender.current();
  }, [geometry]);

  /** Material properties update in place — no need to rebuild the mesh. */
  useEffect(() => {
    const physicalMaterial = materialRef.current;
    if (!physicalMaterial) return;

    physicalMaterial.roughness = material.roughness;
    physicalMaterial.metalness = material.metalness;
    physicalMaterial.clearcoat = material.clearcoat;
    physicalMaterial.clearcoatRoughness = 0.25 + 0.5 * (1 - material.clearcoat);
    physicalMaterial.needsUpdate = true;

    requestRender.current();
  }, [material]);

  /** Frame the camera on the stone, and resize the grid to suit. */
  useEffect(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const grid = gridRef.current;
    const scene = sceneRef.current;
    if (!camera || !controls || !scene) return;

    const sizeMetres = Math.max(0.01, scaleHint * MM_TO_SCENE);
    // 2.4× the longest dimension leaves the stone comfortably inside the frame
    // at the 42° field of view without it swimming in empty space.
    const distance = sizeMetres * 2.4;

    camera.position.set(distance * 0.62, distance * 0.48, distance * 0.78);
    camera.near = Math.max(0.0005, sizeMetres / 100);
    camera.far = distance * 40;
    camera.updateProjectionMatrix();

    controls.target.set(0, sizeMetres * 0.32, 0);
    controls.minDistance = sizeMetres * 0.5;
    controls.maxDistance = sizeMetres * 14;
    controls.update();

    if (grid) {
      scene.remove(grid);
      grid.geometry.dispose();
      (grid.material as { dispose: () => void }).dispose();
    }

    const gridSize = sizeMetres * 4;
    const nextGrid = new GridHelper(gridSize, 20, 0x2c313b, 0x1e222a);
    scene.add(nextGrid);
    gridRef.current = nextGrid;
    nextGrid.visible = showGrid;

    requestRender.current();
  }, [scaleHint, resetSignal, showGrid]);

  useEffect(() => {
    if (gridRef.current) {
      gridRef.current.visible = showGrid;
      requestRender.current();
    }
  }, [showGrid]);

  return (
    <div
      ref={containerRef}
      className={[styles.viewport, className ?? ''].filter(Boolean).join(' ')}
      // The canvas is a graphical control; describe it for assistive tech.
      role="img"
      aria-label="Interactive 3D preview of the generated stone. Drag to orbit, scroll to zoom."
    />
  );
}

/** Exported so the exporter can reuse the same unit convention. */
export { MM_TO_SCENE };
export type { Vector3 };
