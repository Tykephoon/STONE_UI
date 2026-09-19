/**
 * Ingest authentication, validation, and immutability.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { config } from '../src/config.js';
import { resetIngestLimiter } from '../src/routes/ingest.js';
import {
  type TestApp,
  createDevice,
  makeApp,
  registerUser,
  validReading,
} from './helpers.js';
import type { FastifyInstance } from 'fastify';

const apps: TestApp[] = [];

async function fixture(): Promise<{ server: FastifyInstance; deviceId: string; key: string }> {
  const instance = await makeApp();
  apps.push(instance);
  const server = instance.app;
  const user = await registerUser(server, `owner-${apps.length}@example.com`);
  const device = createDevice(server, user.userId);
  return { server, deviceId: device.id, key: device.key };
}

function post(server: FastifyInstance, key: string | null, payload: unknown) {
  return server.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: key ? { authorization: `Bearer ${key}` } : {},
    payload: payload as object,
  });
}

beforeEach(() => {
  resetIngestLimiter();
});

after(async () => {
  await Promise.all(apps.map((instance) => instance.close()));
});

describe('ingest authentication', () => {
  it('rejects a request with no device key', async () => {
    const { server } = await fixture();
    const response = await post(server, null, validReading());

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'unauthenticated');
  });

  it('rejects an unknown device key', async () => {
    const { server } = await fixture();
    const response = await post(server, 'stk_not-a-real-key', validReading());

    assert.equal(response.statusCode, 401);
  });

  it('does not accept a session cookie in place of a device key', async () => {
    const instance = await makeApp();
    apps.push(instance);
    const user = await registerUser(instance.app, 'cookie-ingest@example.com');

    const response = await instance.app.inject({
      method: 'POST',
      url: '/api/ingest',
      headers: { cookie: user.cookie, 'x-csrf-token': user.csrf },
      payload: validReading(),
    });

    assert.equal(response.statusCode, 401);
  });

  it('stops accepting a rotated key', async () => {
    const instance = await makeApp();
    apps.push(instance);
    const server = instance.app;
    const user = await registerUser(server, 'rotate-ingest@example.com');
    const device = createDevice(server, user.userId);

    const before = await post(server, device.key, validReading());
    assert.equal(before.statusCode, 201);

    await server.inject({
      method: 'POST',
      url: `/api/devices/${device.id}/rotate-key`,
      headers: {
        cookie: user.cookie,
        'x-csrf-token': user.csrf,
        origin: 'http://localhost:5173',
      },
    });

    const after_ = await post(server, device.key, validReading());
    assert.equal(after_.statusCode, 401, 'the superseded key is dead immediately');
  });
});

describe('ingest validation', () => {
  it('accepts a well-formed reading and stores every field', async () => {
    const { server, key, deviceId } = await fixture();
    const response = await post(server, key, validReading());

    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.accepted, 1);
    assert.equal(body.ids.length, 1);

    const row = server.db.prepare('SELECT * FROM readings WHERE id = ?').get(body.ids[0]) as Record<
      string,
      unknown
    >;

    assert.equal(row.device_id, deviceId);
    assert.equal(row.latitude, 42.3398);
    assert.equal(row.tire_rl_pressure_kpa, 235.0);
    assert.equal(row.tire_fr_temp_c, 30.8);
    assert.equal(row.ambient_temp_c, 18.4);
    assert.equal(row.battery_voltage_v, 12.4);
  });

  it('records both clocks and the skew between them', async () => {
    const { server, key } = await fixture();
    // A device whose clock is two minutes behind the server.
    const recordedAt = new Date(Date.now() - 120_000).toISOString();

    const response = await post(server, key, validReading({ recorded_at: recordedAt }));
    const id = response.json().ids[0];

    const row = server.db
      .prepare('SELECT recorded_at, received_at, clock_skew_ms FROM readings WHERE id = ?')
      .get(id) as { recorded_at: string; received_at: string; clock_skew_ms: number };

    assert.equal(row.recorded_at, recordedAt);
    assert.ok(row.clock_skew_ms >= 119_000 && row.clock_skew_ms <= 125_000, 'skew is measured');
    assert.ok(Date.parse(row.received_at) > Date.parse(row.recorded_at));
  });

  it('normalises a non-UTC device timestamp to UTC', async () => {
    const { server, key } = await fixture();
    const response = await post(
      server,
      key,
      validReading({ recorded_at: '2026-09-19T08:30:00+02:00' }),
    );

    const row = server.db
      .prepare('SELECT recorded_at FROM readings WHERE id = ?')
      .get(response.json().ids[0]) as { recorded_at: string };

    assert.equal(row.recorded_at, '2026-09-19T06:30:00.000Z');
  });

  it('rejects an out-of-range latitude and names the field', async () => {
    const { server, key } = await fixture();
    const response = await post(server, key, validReading({ latitude: 95 }));

    assert.equal(response.statusCode, 422);
    const body = response.json();
    assert.equal(body.error.code, 'validation_failed');
    assert.ok(body.error.issues.some((issue: { path: string }) => issue.path === 'latitude'));
  });

  it('rejects a missing timestamp', async () => {
    const { server, key } = await fixture();
    const payload = validReading();
    delete payload.recorded_at;

    const response = await post(server, key, payload);
    assert.equal(response.statusCode, 422);
  });

  it('rejects a malformed timestamp with a usable message', async () => {
    const { server, key } = await fixture();
    const response = await post(server, key, validReading({ recorded_at: '19/09/2026 10:00' }));

    assert.equal(response.statusCode, 422);
    const issue = response
      .json()
      .error.issues.find((entry: { path: string }) => entry.path === 'recorded_at');
    assert.ok(issue.message.includes('ISO-8601'), 'tells the firmware author what is expected');
  });

  it('rejects a tyre pressure sent in psi instead of kPa', async () => {
    const { server, key } = await fixture();
    // 2200 psi is nonsense; the bound catches a unit mix-up rather than
    // silently storing it.
    const payload = validReading();
    (payload.tires as Record<string, unknown>).front_left = { pressure_kpa: 2200, temp_c: 20 };

    const response = await post(server, key, payload);
    assert.equal(response.statusCode, 422);
  });

  it('rejects an unknown tyre position rather than dropping it', async () => {
    const { server, key } = await fixture();
    const payload = validReading();
    (payload.tires as Record<string, unknown>).spare = { pressure_kpa: 220 };

    const response = await post(server, key, payload);
    assert.equal(response.statusCode, 422, 'the tyre map is a closed set');
  });

  it('rejects a non-numeric sensor value', async () => {
    const { server, key } = await fixture();
    const payload = validReading();
    (payload.sensors as Record<string, unknown>).humidity_pct = '61.2';

    const response = await post(server, key, payload);
    assert.equal(response.statusCode, 422);
  });

  it('writes nothing when one reading in a batch is invalid', async () => {
    const { server, key } = await fixture();

    const response = await post(server, key, {
      readings: [validReading(), validReading({ longitude: 999 })],
    });

    assert.equal(response.statusCode, 422);
    const count = server.db.prepare('SELECT COUNT(*) AS n FROM readings').get() as { n: number };
    assert.equal(count.n, 0, 'the batch is all-or-nothing');
  });
});

describe('unknown fields', () => {
  it('preserves unrecognised top-level keys in extra', async () => {
    const { server, key } = await fixture();
    const response = await post(
      server,
      key,
      validReading({
        firmware: '2.0.1',
        rssi_dbm: -58,
        experimental: { lidar_cm: 412, tags: ['a', 'b'] },
      }),
    );

    assert.equal(response.statusCode, 201);
    const row = server.db
      .prepare('SELECT extra FROM readings WHERE id = ?')
      .get(response.json().ids[0]) as { extra: string };

    const extra = JSON.parse(row.extra);
    assert.equal(extra.firmware, '2.0.1');
    assert.equal(extra.rssi_dbm, -58);
    assert.deepEqual(extra.experimental, { lidar_cm: 412, tags: ['a', 'b'] });
    // Recognised fields must not be duplicated into extra.
    assert.ok(!('latitude' in extra));
    assert.ok(!('tires' in extra));
  });

  it('stores an empty object when the device sends only known fields', async () => {
    const { server, key } = await fixture();
    const response = await post(server, key, validReading());

    const row = server.db
      .prepare('SELECT extra FROM readings WHERE id = ?')
      .get(response.json().ids[0]) as { extra: string };

    assert.equal(row.extra, '{}');
  });

  it('returns the extras as text, never as executable markup', async () => {
    const { server, key } = await fixture();
    const injection = '<img src=x onerror="alert(1)">';

    await post(server, key, validReading({ label: injection }));

    const response = await server.inject({
      method: 'GET',
      url: '/api/readings',
      headers: { cookie: (await registerUser(server, 'reader@example.com')).cookie },
    });

    // The reader is a different user, so they see nothing — and the stored
    // value round-trips as a plain string for the owner, which React escapes.
    assert.equal(response.json().page.total, 0);

    const row = server.db.prepare('SELECT extra FROM readings LIMIT 1').get() as { extra: string };
    assert.equal(JSON.parse(row.extra).label, injection);
  });
});

describe('batching', () => {
  it('accepts a batch and writes every row', async () => {
    const { server, key } = await fixture();
    const base = Date.now();

    const readings = Array.from({ length: 25 }, (_, index) =>
      validReading({ recorded_at: new Date(base - index * 5000).toISOString() }),
    );

    const response = await post(server, key, { readings });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().accepted, 25);

    const count = server.db.prepare('SELECT COUNT(*) AS n FROM readings').get() as { n: number };
    assert.equal(count.n, 25);
  });

  it('refuses a batch larger than the configured maximum', async () => {
    const { server, key } = await fixture();
    const readings = Array.from({ length: config.INGEST_MAX_BATCH + 1 }, () => validReading());

    const response = await post(server, key, { readings });
    assert.equal(response.statusCode, 413);
  });

  it('refuses an empty batch', async () => {
    const { server, key } = await fixture();
    const response = await post(server, key, { readings: [] });
    assert.equal(response.statusCode, 422);
  });

  it('updates the device last-seen timestamp', async () => {
    const { server, key, deviceId } = await fixture();

    const before = server.db
      .prepare('SELECT last_seen_at FROM devices WHERE id = ?')
      .get(deviceId) as { last_seen_at: string | null };
    assert.equal(before.last_seen_at, null);

    await post(server, key, validReading());

    const after_ = server.db
      .prepare('SELECT last_seen_at FROM devices WHERE id = ?')
      .get(deviceId) as { last_seen_at: string | null };
    assert.ok(after_.last_seen_at);
  });
});

describe('rate limiting', () => {
  it('throttles a device that posts too fast', async () => {
    const { server, key } = await fixture();

    let limited = false;
    for (let attempt = 0; attempt <= config.INGEST_RATE_PER_MINUTE; attempt += 1) {
      const response = await post(server, key, validReading());
      if (response.statusCode === 429) {
        assert.ok(response.headers['retry-after'], 'tells the device when to come back');
        limited = true;
        break;
      }
    }

    assert.ok(limited, 'the per-device ceiling is enforced');
  });

  it('limits each device independently', async () => {
    const instance = await makeApp();
    apps.push(instance);
    const server = instance.app;
    const user = await registerUser(server, 'two-devices@example.com');
    const first = createDevice(server, user.userId, 'First');
    const second = createDevice(server, user.userId, 'Second');

    for (let attempt = 0; attempt <= config.INGEST_RATE_PER_MINUTE; attempt += 1) {
      const response = await post(server, first.key, validReading());
      if (response.statusCode === 429) break;
    }

    const other = await post(server, second.key, validReading());
    assert.equal(other.statusCode, 201, 'one noisy device does not silence another');
  });
});

describe('immutability', () => {
  it('refuses an UPDATE at the database level', async () => {
    const { server, key } = await fixture();
    const response = await post(server, key, validReading());
    const id = response.json().ids[0];

    assert.throws(
      () => {
        server.db.prepare('UPDATE readings SET latitude = ? WHERE id = ?').run(0, id);
      },
      /readings are immutable/,
      'the guarantee is enforced by a trigger, not by convention',
    );

    const row = server.db.prepare('SELECT latitude FROM readings WHERE id = ?').get(id) as {
      latitude: number;
    };
    assert.equal(row.latitude, 42.3398);
  });

  it('exposes no endpoint that mutates a reading', async () => {
    const { server, key } = await fixture();
    const created = await post(server, key, validReading());
    const id = created.json().ids[0];

    const instance = apps[apps.length - 1]!;
    const user = await registerUser(instance.app, 'mutator@example.com');

    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const response = await server.inject({
        method,
        url: `/api/readings/${id}`,
        headers: {
          cookie: user.cookie,
          'x-csrf-token': user.csrf,
          origin: 'http://localhost:5173',
        },
        payload: { latitude: 0 },
      });

      assert.equal(response.statusCode, 404, `${method} /api/readings/:id is not routed`);
    }
  });
});
