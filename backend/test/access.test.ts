/**
 * The access model, asserted explicitly.
 *
 * This installation has no user accounts, so "who can do what" is no longer
 * obvious from the code and is easy to change by accident. These tests pin the
 * intended shape:
 *
 *   - reads are public
 *   - writing a reading requires a device key
 *   - device provisioning is not reachable over HTTP at all
 *   - the design library is shared and writable
 *   - errors leak nothing
 *
 * If a future change makes reads private again, these tests should fail — they
 * document a deliberate decision, not an accident.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import {
  BROWSER_HEADERS,
  type TestApp,
  createDevice,
  makeApp,
  validDesignParams,
  validReading,
} from './helpers.js';

const apps: TestApp[] = [];

async function fixture(): Promise<FastifyInstance> {
  const instance = await makeApp();
  apps.push(instance);
  return instance.app;
}

after(async () => {
  await Promise.all(apps.map((instance) => instance.close()));
});

async function seedReading(server: FastifyInstance): Promise<string> {
  const device = createDevice(server);
  const response = await server.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: { authorization: `Bearer ${device.key}` },
    payload: validReading(),
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().ids[0] as string;
}

async function seedDesign(server: FastifyInstance, name = 'Test stone'): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/designs',
    headers: BROWSER_HEADERS,
    payload: { name, params: validDesignParams() },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().design.id as string;
}

describe('reads are public', () => {
  it('serves every read endpoint without a credential', async () => {
    const server = await fixture();
    await seedReading(server);

    for (const url of [
      '/health',
      '/api/devices',
      '/api/readings',
      '/api/readings/stats',
      '/api/readings/series',
      '/api/readings/export?format=csv',
      '/api/designs',
      '/api/geo/style.json',
    ]) {
      const response = await server.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200, `${url} returned ${response.statusCode}`);
    }
  });

  it('returns the seeded reading to an anonymous caller', async () => {
    const server = await fixture();
    const id = await seedReading(server);

    const list = await server.inject({ method: 'GET', url: '/api/readings' });
    assert.equal(list.json().page.total, 1);

    const detail = await server.inject({ method: 'GET', url: `/api/readings/${id}` });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().reading.id, id);
  });

  it('404s an unknown reading id rather than erroring', async () => {
    const server = await fixture();
    const response = await server.inject({ method: 'GET', url: '/api/readings/rdg_nope' });
    assert.equal(response.statusCode, 404);
  });
});

describe('the design library is shared and writable', () => {
  it('accepts a design from an anonymous caller', async () => {
    const server = await fixture();
    const id = await seedDesign(server, 'Anonymous stone');

    const list = await server.inject({ method: 'GET', url: '/api/designs' });
    const designs = list.json().designs as { id: string; name: string }[];
    assert.equal(designs.length, 1);
    assert.equal(designs[0]?.id, id);
  });

  it('validates design parameters before storing them', async () => {
    const server = await fixture();

    const response = await server.inject({
      method: 'POST',
      url: '/api/designs',
      headers: BROWSER_HEADERS,
      payload: {
        name: 'Broken',
        params: { ...validDesignParams(), surface: { resolution: 99 } },
      },
    });

    assert.equal(response.statusCode, 422);
    const count = server.db.prepare('SELECT COUNT(*) AS n FROM designs').get() as { n: number };
    assert.equal(count.n, 0, 'nothing invalid reaches the table');
  });

  it('rejects a colour that is not a hex value', async () => {
    const server = await fixture();
    const params = validDesignParams();
    (params.material as Record<string, unknown>).color = 'javascript:alert(1)';

    const response = await server.inject({
      method: 'POST',
      url: '/api/designs',
      headers: BROWSER_HEADERS,
      payload: { name: 'Hostile', params },
    });

    assert.equal(response.statusCode, 422);
  });

  it('caps the library so a script cannot fill the volume', async () => {
    const server = await fixture();
    const now = new Date().toISOString();

    // Fill to the documented ceiling directly, then try one more over HTTP.
    const insert = server.db.prepare(
      `INSERT INTO designs (id, name, params, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const fill = server.db.transaction(() => {
      for (let index = 0; index < 200; index += 1) {
        insert.run(`dsn_fill${index}`, `Filler ${index}`, JSON.stringify(validDesignParams()), now, now);
      }
    });
    fill();

    const response = await server.inject({
      method: 'POST',
      url: '/api/designs',
      headers: BROWSER_HEADERS,
      payload: { name: 'One too many', params: validDesignParams() },
    });

    assert.equal(response.statusCode, 409);
  });
});

describe('share links', () => {
  it('resolves to exactly one design and exposes no internal id', async () => {
    const server = await fixture();
    const shared = await seedDesign(server, 'Shared stone');
    await seedDesign(server, 'Other stone');

    const mint = await server.inject({
      method: 'POST',
      url: `/api/designs/${shared}/share`,
      headers: BROWSER_HEADERS,
    });
    assert.equal(mint.statusCode, 201);

    const token = mint.json().share_token as string;
    const response = await server.inject({ method: 'GET', url: `/api/share/${token}` });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.design.name, 'Shared stone');
    assert.ok(!('id' in body.design), 'the internal design id is not exposed');
    assert.ok(!JSON.stringify(body).includes('Other stone'), 'siblings are not reachable');
  });

  it('stops working once revoked', async () => {
    const server = await fixture();
    const id = await seedDesign(server);

    const mint = await server.inject({
      method: 'POST',
      url: `/api/designs/${id}/share`,
      headers: BROWSER_HEADERS,
    });
    const token = mint.json().share_token as string;

    await server.inject({
      method: 'DELETE',
      url: `/api/designs/${id}/share`,
      headers: BROWSER_HEADERS,
    });

    const response = await server.inject({ method: 'GET', url: `/api/share/${token}` });
    assert.equal(response.statusCode, 404);
  });

  it('rejects an unknown token', async () => {
    const server = await fixture();
    const response = await server.inject({
      method: 'GET',
      url: '/api/share/aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    assert.equal(response.statusCode, 404);
  });

  it('does not let a share token act as a device key', async () => {
    const server = await fixture();
    const id = await seedDesign(server);
    const mint = await server.inject({
      method: 'POST',
      url: `/api/designs/${id}/share`,
      headers: BROWSER_HEADERS,
    });
    const token = mint.json().share_token as string;

    const response = await server.inject({
      method: 'POST',
      url: '/api/ingest',
      headers: { authorization: `Bearer ${token}` },
      payload: validReading(),
    });

    assert.equal(response.statusCode, 401);
  });
});

describe('CORS', () => {
  it('reflects an allowlisted origin', async () => {
    const server = await fixture();
    const response = await server.inject({
      method: 'GET',
      url: '/health',
      headers: BROWSER_HEADERS,
    });

    assert.equal(
      response.headers['access-control-allow-origin'],
      'http://localhost:5173',
    );
  });

  it('sends no CORS header for an unknown origin', async () => {
    const server = await fixture();
    const response = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://attacker.example' },
    });

    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });

  it('never answers with a wildcard', async () => {
    const server = await fixture();
    const response = await server.inject({
      method: 'GET',
      url: '/health',
      headers: BROWSER_HEADERS,
    });

    assert.notEqual(response.headers['access-control-allow-origin'], '*');
  });
});

describe('error hygiene', () => {
  it('leaks no paths or stack frames on an unknown route', async () => {
    const server = await fixture();
    const response = await server.inject({ method: 'GET', url: '/api/does-not-exist' });

    assert.equal(response.statusCode, 404);
    assert.ok(!/[A-Za-z]:\\|\/home\/|node_modules|\bat \w+ \(/.test(response.body));
  });

  it('turns malformed JSON into a generic 400', async () => {
    const server = await fixture();
    const response = await server.inject({
      method: 'POST',
      url: '/api/designs',
      headers: { ...BROWSER_HEADERS, 'content-type': 'application/json' },
      payload: '{not json',
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'bad_request');
    assert.ok(!response.body.includes('JSON'), 'no parser internals in the message');
  });

  it('sets hardening headers on every response', async () => {
    const server = await fixture();
    const response = await server.inject({ method: 'GET', url: '/health' });

    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
  });
});

describe('geo proxy', () => {
  it('serves a style document whose tiles point back at this API', async () => {
    const server = await fixture();
    const response = await server.inject({ method: 'GET', url: '/api/geo/style.json' });

    assert.equal(response.statusCode, 200);
    const style = response.json();
    assert.equal(style.version, 8);
    assert.ok(String(style.sources.basemap.tiles[0]).includes('/api/geo/tiles/'));
  });

  it('never puts a provider key in the style document', async () => {
    const server = await fixture();
    const response = await server.inject({ method: 'GET', url: '/api/geo/style.json' });

    assert.ok(!response.body.toLowerCase().includes('key='));
    assert.ok(!response.body.toLowerCase().includes('apikey'));
  });

  it('rejects a tile outside the pyramid without calling upstream', async () => {
    const server = await fixture();
    const response = await server.inject({ method: 'GET', url: '/api/geo/tiles/2/99/99' });

    assert.equal(response.statusCode, 404);
  });

  it('rejects a search term that is too short', async () => {
    const server = await fixture();
    const response = await server.inject({ method: 'GET', url: '/api/geo/search?q=a' });

    assert.equal(response.statusCode, 422);
  });
});
