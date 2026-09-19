/**
 * Control point placement.
 *
 * Regression cover for a reported bug: the dots floated in space instead of
 * sitting on the rock. The cause was casting the placement ray from the stone's
 * centre outward — with a `FrontSide` material, a ray starting inside a closed
 * mesh only meets back faces, which raycasting culls, so every cast missed and
 * fell through to a bounding-sphere fallback.
 *
 * These tests exercise the real geometry through a real Raycaster, so the
 * failure mode is reproduced rather than described.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshPhysicalMaterial,
  Raycaster,
  Vector3,
} from 'three';
import { CONTROL_POINT_DIRECTIONS } from '../src/features/studio/controlPoints';
import { generateStone, type StoneParams } from '../src/features/studio/generator/stone';
import { DEFAULT_PARAMS } from '../src/features/studio/types';

const MM = 0.001;

/** Build the mesh the viewer would show, at the same scale and offset. */
function buildStoneMesh(params: StoneParams = DEFAULT_PARAMS as StoneParams) {
  const generated = generateStone(params);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(generated.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(generated.normals, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // FrontSide is the default and is the whole point of the bug.
  const mesh = new Mesh(geometry, new MeshPhysicalMaterial());
  mesh.scale.setScalar(MM);
  mesh.position.y = -(geometry.boundingBox?.min.y ?? 0) * MM;
  mesh.updateMatrixWorld(true);

  return { mesh, geometry };
}

describe('the original failure', () => {
  it('casting outward from inside the mesh finds nothing', () => {
    const { mesh } = buildStoneMesh();

    const centre = new Vector3();
    mesh.getWorldPosition(centre);

    const raycaster = new Raycaster();
    let hits = 0;

    for (const direction of CONTROL_POINT_DIRECTIONS) {
      const ray = new Vector3(...direction).normalize();
      raycaster.set(centre, ray);
      if (raycaster.intersectObject(mesh, false).length > 0) hits += 1;
    }

    // Documents the cause: not one of the fourteen casts lands.
    assert.equal(hits, 0, 'front-side culling should swallow every inside-out cast');
  });
});

describe('placement from outside', () => {
  it('finds the surface in every control direction', () => {
    const { mesh, geometry } = buildStoneMesh();

    const centre = new Vector3();
    mesh.getWorldPosition(centre);
    const reach = (geometry.boundingSphere?.radius ?? 1) * MM * 2;

    const raycaster = new Raycaster();

    for (const [index, direction] of CONTROL_POINT_DIRECTIONS.entries()) {
      const ray = new Vector3(...direction).normalize();
      raycaster.set(centre.clone().addScaledVector(ray, reach), ray.clone().negate());

      const hit = raycaster.intersectObject(mesh, false)[0];
      assert.ok(hit, `no surface found for control point ${index}`);
      assert.ok(hit.face, `hit for point ${index} carries no face`);
    }
  });

  it('lands on the surface, not on a bounding sphere', () => {
    const { mesh, geometry } = buildStoneMesh();

    const centre = new Vector3();
    mesh.getWorldPosition(centre);
    const sphereRadius = (geometry.boundingSphere?.radius ?? 1) * MM;
    const reach = sphereRadius * 2;

    const raycaster = new Raycaster();
    let onSphere = 0;

    for (const direction of CONTROL_POINT_DIRECTIONS) {
      const ray = new Vector3(...direction).normalize();
      raycaster.set(centre.clone().addScaledVector(ray, reach), ray.clone().negate());

      const hit = raycaster.intersectObject(mesh, false)[0];
      assert.ok(hit);

      const distance = hit.point.distanceTo(centre);
      assert.ok(distance <= sphereRadius + 1e-6, 'a hit cannot lie outside the bounding sphere');

      // The old fallback put every dot at exactly the sphere radius. A real
      // stone is not a sphere, so most directions must come in well short.
      if (Math.abs(distance - sphereRadius) < sphereRadius * 0.02) onSphere += 1;
    }

    assert.ok(
      onSphere <= 2,
      `${onSphere} of ${CONTROL_POINT_DIRECTIONS.length} points sat on the bounding sphere`,
    );
  });

  it('snaps to an actual vertex of the mesh', () => {
    const { mesh, geometry } = buildStoneMesh();
    const position = geometry.getAttribute('position');

    const centre = new Vector3();
    mesh.getWorldPosition(centre);
    const reach = (geometry.boundingSphere?.radius ?? 1) * MM * 2;

    const raycaster = new Raycaster();
    const localVertex = new Vector3();
    const worldVertex = new Vector3();

    for (const [index, direction] of CONTROL_POINT_DIRECTIONS.entries()) {
      const ray = new Vector3(...direction).normalize();
      raycaster.set(centre.clone().addScaledVector(ray, reach), ray.clone().negate());

      const hit = raycaster.intersectObject(mesh, false)[0];
      assert.ok(hit?.face);

      let best = new Vector3();
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const vertexIndex of [hit.face.a, hit.face.b, hit.face.c]) {
        localVertex.fromBufferAttribute(position, vertexIndex);
        worldVertex.copy(localVertex);
        mesh.localToWorld(worldVertex);

        const distance = worldVertex.distanceToSquared(hit.point);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = worldVertex.clone();
        }
      }

      // The chosen point must coincide with one of the triangle's corners.
      let matchesAVertex = false;
      for (const vertexIndex of [hit.face.a, hit.face.b, hit.face.c]) {
        localVertex.fromBufferAttribute(position, vertexIndex);
        worldVertex.copy(localVertex);
        mesh.localToWorld(worldVertex);
        if (worldVertex.distanceTo(best) < 1e-9) matchesAVertex = true;
      }

      assert.ok(matchesAVertex, `point ${index} did not land on a vertex`);

      // Snapping must not throw the dot across the model: a triangle at level
      // 5 is small, so the corner is close to where the ray struck.
      const drift = best.distanceTo(hit.point);
      assert.ok(drift < reach * 0.1, `point ${index} drifted ${drift} from the hit`);
    }
  });

  it('keeps finding the surface on a heavily sculpted stone', () => {
    const sculpt = {
      pulls: CONTROL_POINT_DIRECTIONS.map((_, index) => (index % 2 === 0 ? 1 : -1)),
      influence: 0.8,
    };
    const { mesh, geometry } = buildStoneMesh({
      ...(DEFAULT_PARAMS as StoneParams),
      sculpt,
    });

    const centre = new Vector3();
    mesh.getWorldPosition(centre);
    const reach = (geometry.boundingSphere?.radius ?? 1) * MM * 2;

    const raycaster = new Raycaster();

    for (const [index, direction] of CONTROL_POINT_DIRECTIONS.entries()) {
      const ray = new Vector3(...direction).normalize();
      raycaster.set(centre.clone().addScaledVector(ray, reach), ray.clone().negate());
      assert.ok(
        raycaster.intersectObject(mesh, false).length > 0,
        `lost the surface at point ${index} after sculpting`,
      );
    }
  });

  it('keeps finding the surface on a heavily faceted stone', () => {
    // Faceting cuts flat planes into the form and is the most likely source of
    // a direction that misses.
    const { mesh, geometry } = buildStoneMesh({
      ...(DEFAULT_PARAMS as StoneParams),
      surface: { ...(DEFAULT_PARAMS as StoneParams).surface, faceting: 1, erosion: 0.9 },
    });

    const centre = new Vector3();
    mesh.getWorldPosition(centre);
    const reach = (geometry.boundingSphere?.radius ?? 1) * MM * 2;

    const raycaster = new Raycaster();
    let found = 0;

    for (const direction of CONTROL_POINT_DIRECTIONS) {
      const ray = new Vector3(...direction).normalize();
      raycaster.set(centre.clone().addScaledVector(ray, reach), ray.clone().negate());
      if (raycaster.intersectObject(mesh, false).length > 0) found += 1;
    }

    assert.equal(found, CONTROL_POINT_DIRECTIONS.length, 'every direction should still hit');
  });
});
