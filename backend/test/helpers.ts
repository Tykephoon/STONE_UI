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

/**
 * Insert a device directly and return its plaintext key.
 *
 * Mirrors what `npm run device -- add` does. There is no HTTP route for this by
 * design, so tests go straight to the database as the CLI would.
 */
export function createDevice(
  app: FastifyInstance,
  name = 'Test Pico',
): { id: string; key: string } {
  const id = newId('dev');
  const secret = newSecret(32);
  const key = `stk_${secret}`;

  app.db
    .prepare(
      `INSERT INTO devices (id, name, key_hash, key_prefix, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, name, sha256(key), `stk_${secret.slice(0, 6)}`, new Date().toISOString());

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

/** Valid design parameters, matching the studio's defaults. */
export function validDesignParams(): Record<string, unknown> {
  return {
    seed: '42.33980,-71.08920',
    dimensions: { length_mm: 220, width_mm: 160, height_mm: 120 },
    form: { roundness: 0.55, taper: 0, asymmetry: 0.35, flatten: 0.2, bulge: 0.3 },
    surface: { detail: 0.55, grain: 0.45, erosion: 0.3, faceting: 0, resolution: 5 },
    material: {
      color: '#8a8577',
      accentColor: '#5c5850',
      roughness: 0.88,
      metalness: 0.03,
      speckle: 0.35,
      clearcoat: 0,
    },
  };
}

/** Headers a browser would send from the allowlisted origin. */
export const BROWSER_HEADERS = { origin: 'http://localhost:5173' };
