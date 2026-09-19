/**
 * Test harness.
 *
 * Each test builds its own app over a fresh in-memory database, so tests share
 * no state: no ports, no fixtures to reset, no ordering dependencies.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { sha256 } from '../src/lib/crypto.js';
import { newId, newSecret } from '../src/lib/ids.js';

export interface TestApp {
  app: FastifyInstance;
  close: () => Promise<void>;
}

export async function makeApp(): Promise<TestApp> {
  const db = openDatabase(':memory:');
  const app = await buildApp({ db, logger: false });
  await app.ready();

  return {
    app,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

export interface Session {
  cookie: string;
  csrf: string;
  userId: string;
  email: string;
}

/** Collapse a Fastify inject response's Set-Cookie headers into a request header. */
export function cookieHeader(response: { cookies: unknown[] }): string {
  return (response.cookies as { name: string; value: string }[])
    .filter((entry) => entry.value !== '')
    .map((entry) => `${entry.name}=${entry.value}`)
    .join('; ');
}

export function cookieValue(response: { cookies: unknown[] }, name: string) {
  return (response.cookies as { name: string; value: string; [key: string]: unknown }[]).find(
    (entry) => entry.name === name,
  );
}

export const TEST_PASSWORD = 'a-sufficiently-long-password';

export async function registerUser(
  app: FastifyInstance,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password },
  });

  if (response.statusCode !== 201) {
    throw new Error(`register failed (${response.statusCode}): ${response.body}`);
  }

  const body = response.json() as { user: { id: string }; csrf_token: string };

  return {
    cookie: cookieHeader(response),
    csrf: body.csrf_token,
    userId: body.user.id,
    email,
  };
}

/** Headers for an authenticated, state-changing request. */
export function authHeaders(session: Session): Record<string, string> {
  return {
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
    origin: 'http://localhost:5173',
  };
}

/** Insert a device directly and return its plaintext key. */
export function createDevice(
  app: FastifyInstance,
  userId: string,
  name = 'Test Pico',
): { id: string; key: string } {
  const id = newId('dev');
  const secret = newSecret(32);
  const key = `stk_${secret}`;

  app.db
    .prepare(
      `INSERT INTO devices (id, user_id, name, key_hash, key_prefix, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, name, sha256(key), `stk_${secret.slice(0, 6)}`, new Date().toISOString());

  return { id, key };
}

/** A valid ingest payload, with overrides merged in. */
export function validReading(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recorded_at: new Date().toISOString(),
    latitude: 42.3398,
    longitude: -71.0892,
    altitude_m: 14.2,
    gps_accuracy_m: 4.5,
    tires: {
      front_left: { pressure_kpa: 228.4, temp_c: 31.2 },
      front_right: { pressure_kpa: 229.1, temp_c: 30.8 },
      rear_left: { pressure_kpa: 235.0, temp_c: 33.4 },
      rear_right: { pressure_kpa: 234.2, temp_c: 33.1 },
    },
    sensors: {
      ambient_temp_c: 18.4,
      humidity_pct: 61.2,
      barometric_pressure_hpa: 1014.2,
      accel_x_g: 0.02,
      accel_y_g: -0.01,
      accel_z_g: 1.0,
      battery_voltage_v: 12.4,
    },
    ...overrides,
  };
}
