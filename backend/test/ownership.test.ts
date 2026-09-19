/**
 * Ownership enforcement.
 *
 * The premise of every test here: an attacker knows the exact ID of another
 * user's record and presents a perfectly valid session of their own. Nothing in
 * the SPA is involved. The API alone has to refuse.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
  type Session,
  type TestApp,
  authHeaders,
  createDevice,
  makeApp,
  registerUser,
  validReading,
} from './helpers.js';
import type { FastifyInstance } from 'fastify';

const apps: TestApp[] = [];

interface Fixture {
  server: FastifyInstance;
  alice: Session;
  bob: Session;
}

/** Two users, each with a device, a reading, and a saved design. */
async function fixture(): Promise<Fixture> {
  const instance = await makeApp();
  apps.push(instance);
  const server = instance.app;

  const alice = await registerUser(server, 'alice@example.com');
  const bob = await registerUser(server, 'bob@example.com');

  return { server, alice, bob };
}

after(async () => {
  await Promise.all(apps.map((instance) => instance.close()));
});

async function seedDesign(server: FastifyInstance, session: Session, name: string) {
  const response = await server.inject({
    method: 'POST',
    url: '/api/designs',
    headers: authHeaders(session),
    payload: {
      name,
      params: {
        seed: 'seed-value',
        dimensions: { length_mm: 200, width_mm: 150, height_mm: 120 },
        form: { roundness: 0.5, taper: 0, asymmetry: 0.3, flatten: 0.2, bulge: 0.4 },
        surface: { detail: 0.5, grain: 0.4, erosion: 0.3, faceting: 0.2, resolution: 4 },
        material: {
          color: '#8a8577',
          accentColor: '#5f5b52',
          roughness: 0.8,
          metalness: 0.05,
          speckle: 0.3,
          clearcoat: 0.1,
        },
      },
    },
  });

  assert.equal(response.statusCode, 201, response.body);
  return response.json().design.id as string;
}

async function ingest(server: FastifyInstance, key: string) {
  const response = await server.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: { authorization: `Bearer ${key}` },
    payload: validReading(),
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().ids[0] as string;
}

describe('device ownership', () => {
  it("hides another user's device behind 404, not 403", async () => {
    const { server, alice, bob } = await fixture();
    const aliceDevice = createDevice(server, alice.userId, "Alice's Pico");

    const response = await server.inject({
      method: 'GET',
      url: `/api/devices/${aliceDevice.id}`,
      headers: { cookie: bob.cookie },
    });

    // 403 would confirm the ID is real. 404 tells a prober nothing.
    assert.equal(response.statusCode, 404);
  });

  it("refuses to rename another user's device", async () => {
    const { server, alice, bob } = await fixture();
    const aliceDevice = createDevice(server, alice.userId);

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/devices/${aliceDevice.id}`,
      headers: authHeaders(bob),
      payload: { name: 'Stolen' },
    });

    assert.equal(response.statusCode, 404);

    const unchanged = server.db
      .prepare('SELECT name FROM devices WHERE id = ?')
      .get(aliceDevice.id) as { name: string };
    assert.equal(unchanged.name, 'Test Pico');
  });

  it("refuses to delete another user's device", async () => {
    const { server, alice, bob } = await fixture();
    const aliceDevice = createDevice(server, alice.userId);

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/devices/${aliceDevice.id}`,
      headers: authHeaders(bob),
    });

    assert.equal(response.statusCode, 404);
    assert.ok(server.db.prepare('SELECT id FROM devices WHERE id = ?').get(aliceDevice.id));
  });

  it("refuses to rotate another user's device key", async () => {
    const { server, alice, bob } = await fixture();
    const aliceDevice = createDevice(server, alice.userId);
    const before = server.db
      .prepare('SELECT key_hash FROM devices WHERE id = ?')
      .get(aliceDevice.id) as { key_hash: string };

    const response = await server.inject({
      method: 'POST',
      url: `/api/devices/${aliceDevice.id}/rotate-key`,
      headers: authHeaders(bob),
    });

    assert.equal(response.statusCode, 404);

    const after_ = server.db
      .prepare('SELECT key_hash FROM devices WHERE id = ?')
      .get(aliceDevice.id) as { key_hash: string };
    assert.equal(after_.key_hash, before.key_hash, "Alice's device key still works");
  });

  it('lists only the caller’s own devices', async () => {
    const { server, alice, bob } = await fixture();
    createDevice(server, alice.userId, 'Alice One');
    createDevice(server, bob.userId, 'Bob One');

    const response = await server.inject({
      method: 'GET',
      url: '/api/devices',
      headers: { cookie: bob.cookie },
    });

    const devices = response.json().devices as { name: string }[];
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.name, 'Bob One');
  });
});

describe('reading ownership', () => {
  it("hides another user's reading", async () => {
    const { server, alice, bob } = await fixture();
    const aliceDevice = createDevice(server, alice.userId);
    const readingId = await ingest(server, aliceDevice.key);

    const response = await server.inject({
      method: 'GET',
      url: `/api/readings/${readingId}`,
      headers: { cookie: bob.cookie },
    });

    assert.equal(response.statusCode, 404);
  });

  it('scopes the reading list to the caller', async () => {
    const { server, alice, bob } = await fixture();
    const aliceDevice = createDevice(server, alice.userId);
    const bobDevice = createDevice(server, bob.userId, 'Bob Pico');
    await ingest(server, aliceDevice.key);
    await ingest(server, aliceDevice.key);
    await ingest(server, bobDevice.key);

    const response = await server.inject({
      method: 'GET',
      url: '/api/readings',
      headers: { cookie: bob.cookie },
    });

    const body = response.json();
    assert.equal(body.page.total, 1);
    assert.equal(body.readings[0].device_name, 'Bob Pico');
  });

  it("ignores a device_id filter pointing at someone else's device", async () => {
    const { server, alice, bob } = await fixture();
    const aliceDevice = createDevice(server, alice.userId);
    await ingest(server, aliceDevice.key);

    const response = await server.inject({
      method: 'GET',
      url: `/api/readings?device_id=${aliceDevice.id}`,
      headers: { cookie: bob.cookie },
    });

    // The user_id condition still applies, so the filter matches nothing.
    assert.equal(response.json().page.total, 0);
  });

  it('scopes statistics to the caller', async () => {
    const { server, alice, bob } = await fixture();
    const aliceDevice = createDevice(server, alice.userId);
    await ingest(server, aliceDevice.key);
    await ingest(server, aliceDevice.key);

    const response = await server.inject({
      method: 'GET',
      url: '/api/readings/stats',
      headers: { cookie: bob.cookie },
    });

    assert.equal(response.json().total, 0);
  });
});

describe('design ownership', () => {
  it("hides another user's design", async () => {
    const { server, alice, bob } = await fixture();
    const designId = await seedDesign(server, alice, 'Alice Stone');

    const response = await server.inject({
      method: 'GET',
      url: `/api/designs/${designId}`,
      headers: { cookie: bob.cookie },
    });

    assert.equal(response.statusCode, 404);
  });

  it("refuses to overwrite another user's design", async () => {
    const { server, alice, bob } = await fixture();
    const designId = await seedDesign(server, alice, 'Alice Stone');

    const response = await server.inject({
      method: 'PUT',
      url: `/api/designs/${designId}`,
      headers: authHeaders(bob),
      payload: { name: 'Hijacked' },
    });

    assert.equal(response.statusCode, 404);

    const row = server.db.prepare('SELECT name FROM designs WHERE id = ?').get(designId) as {
      name: string;
    };
    assert.equal(row.name, 'Alice Stone');
  });

  it("refuses to delete another user's design", async () => {
    const { server, alice, bob } = await fixture();
    const designId = await seedDesign(server, alice, 'Alice Stone');

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/designs/${designId}`,
      headers: authHeaders(bob),
    });

    assert.equal(response.statusCode, 404);
    assert.ok(server.db.prepare('SELECT id FROM designs WHERE id = ?').get(designId));
  });

  it("refuses to mint a share link for another user's design", async () => {
    const { server, alice, bob } = await fixture();
    const designId = await seedDesign(server, alice, 'Alice Stone');

    const response = await server.inject({
      method: 'POST',
      url: `/api/designs/${designId}/share`,
      headers: authHeaders(bob),
    });

    assert.equal(response.statusCode, 404);
    const shares = server.db
      .prepare('SELECT COUNT(*) AS n FROM design_shares WHERE design_id = ?')
      .get(designId) as { n: number };
    assert.equal(shares.n, 0);
  });
});

describe('share links', () => {
  it('exposes exactly one design and no owner identity', async () => {
    const { server, alice } = await fixture();
    const shared = await seedDesign(server, alice, 'Shared Stone');
    await seedDesign(server, alice, 'Private Stone');

    const mint = await server.inject({
      method: 'POST',
      url: `/api/designs/${shared}/share`,
      headers: authHeaders(alice),
    });
    const token = mint.json().share_token as string;

    const response = await server.inject({ method: 'GET', url: `/api/share/${token}` });
    assert.equal(response.statusCode, 200);

    const body = response.json();
    assert.equal(body.design.name, 'Shared Stone');

    // Nothing that identifies the owner, and no way to reach the sibling design.
    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes('alice@example.com'));
    assert.ok(!serialised.includes(alice.userId));
    assert.ok(!serialised.includes('Private Stone'));
    assert.ok(!('user_id' in body.design));
    assert.ok(!('id' in body.design), 'the internal design id is not exposed either');
  });

  it('does not let a share token act as a session', async () => {
    const { server, alice } = await fixture();
    const shared = await seedDesign(server, alice, 'Shared Stone');

    const mint = await server.inject({
      method: 'POST',
      url: `/api/designs/${shared}/share`,
      headers: authHeaders(alice),
    });
    const token = mint.json().share_token as string;

    // Presenting the share token as a session cookie or bearer token must not
    // authenticate anything.
    const asCookie = await server.inject({
      method: 'GET',
      url: '/api/designs',
      headers: { cookie: `stone_session=${token}` },
    });
    assert.equal(asCookie.statusCode, 401);

    const asBearer = await server.inject({
      method: 'GET',
      url: '/api/designs',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(asBearer.statusCode, 401);
  });

  it('stops working once revoked', async () => {
    const { server, alice } = await fixture();
    const shared = await seedDesign(server, alice, 'Shared Stone');

    const mint = await server.inject({
      method: 'POST',
      url: `/api/designs/${shared}/share`,
      headers: authHeaders(alice),
    });
    const token = mint.json().share_token as string;

    await server.inject({
      method: 'DELETE',
      url: `/api/designs/${shared}/share`,
      headers: authHeaders(alice),
    });

    const response = await server.inject({ method: 'GET', url: `/api/share/${token}` });
    assert.equal(response.statusCode, 404);
  });

  it('rejects an unknown token', async () => {
    const { server } = await fixture();
    const response = await server.inject({
      method: 'GET',
      url: '/api/share/aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    assert.equal(response.statusCode, 404);
  });
});

describe('unauthenticated access', () => {
  it('refuses every protected collection', async () => {
    const { server } = await fixture();

    for (const url of [
      '/api/devices',
      '/api/readings',
      '/api/readings/stats',
      '/api/readings/series',
      '/api/designs',
      '/api/geo/style.json',
      '/api/geo/search?q=boston',
    ]) {
      const response = await server.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401, `${url} should require a session`);
    }
  });
});
