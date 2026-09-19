/**
 * Device telemetry ingest.
 *
 * Authenticated with a device key, not a session cookie — this endpoint is
 * called by hardware, not a browser. That also means it needs no CSRF token
 * (it is exempt in the auth plugin) because there is no ambient credential for
 * a malicious page to abuse: a browser will never attach a device key on its
 * own.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import {
  MAX_EXTRA_BYTES,
  ingestBodySchema,
  normaliseReading,
  readingInputSchema,
} from '../domain/reading.js';
import { sha256 } from '../lib/crypto.js';
import { ApiError, rateLimited, unauthenticated, validationFailed } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { RateLimiter } from '../lib/ratelimit.js';
import { parseOrThrow } from '../lib/validate.js';

const ingestLimiter = new RateLimiter(config.INGEST_RATE_PER_MINUTE, 60_000);

/** Exposed so tests can start from a clean window. */
export function resetIngestLimiter(): void {
  ingestLimiter.reset();
}

interface DeviceAuthRow {
  id: string;
  user_id: string;
  name: string;
}

function readBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

const INSERT_READING = `
  INSERT INTO readings (
    id, device_id, user_id,
    recorded_at, received_at, clock_skew_ms,
    latitude, longitude, altitude_m, gps_accuracy_m,
    tire_fl_pressure_kpa, tire_fl_temp_c,
    tire_fr_pressure_kpa, tire_fr_temp_c,
    tire_rl_pressure_kpa, tire_rl_temp_c,
    tire_rr_pressure_kpa, tire_rr_temp_c,
    ambient_temp_c, humidity_pct, barometric_pressure_hpa,
    accel_x_g, accel_y_g, accel_z_g, battery_voltage_v,
    extra, created_at
  ) VALUES (
    @id, @device_id, @user_id,
    @recorded_at, @received_at, @clock_skew_ms,
    @latitude, @longitude, @altitude_m, @gps_accuracy_m,
    @tire_fl_pressure_kpa, @tire_fl_temp_c,
    @tire_fr_pressure_kpa, @tire_fr_temp_c,
    @tire_rl_pressure_kpa, @tire_rl_temp_c,
    @tire_rr_pressure_kpa, @tire_rr_temp_c,
    @ambient_temp_c, @humidity_pct, @barometric_pressure_hpa,
    @accel_x_g, @accel_y_g, @accel_z_g, @battery_voltage_v,
    @extra, @created_at
  )
`;

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  const db = app.db;
  const insert = db.prepare(INSERT_READING);

  const insertMany = db.transaction((rows: Record<string, unknown>[]) => {
    for (const row of rows) insert.run(row);
  });

  app.post(
    '/api/ingest',
    {
      // A device posting a 200-reading batch of fully populated readings needs
      // room; 1 MiB is generous for that and still bounds memory per request.
      bodyLimit: 1024 * 1024,
      config: { rateLimit: false },
    },
    async (request, reply) => {
      const key = readBearerToken(request);
      if (!key) {
        throw unauthenticated('Provide a device key as a bearer token.');
      }

      const device = db
        .prepare('SELECT id, user_id, name FROM devices WHERE key_hash = ?')
        .get(sha256(key)) as DeviceAuthRow | undefined;

      if (!device) {
        // Same message for a malformed key and an unknown one.
        throw unauthenticated('That device key is not valid.');
      }

      const limit = ingestLimiter.check(device.id);
      if (!limit.allowed) {
        reply.header('retry-after', String(limit.retryAfterSeconds));
        throw rateLimited('This device is posting too frequently.');
      }

      const body = parseOrThrow(ingestBodySchema, request.body);
      const inputs =
        'readings' in body && Array.isArray(body.readings)
          ? body.readings
          : [readingInputSchema.parse(body)];

      if (inputs.length > config.INGEST_MAX_BATCH) {
        throw new ApiError(
          'payload_too_large',
          `Send at most ${config.INGEST_MAX_BATCH} readings per request.`,
        );
      }

      const receivedAt = new Date();
      const rows: Record<string, unknown>[] = [];
      const ids: string[] = [];

      for (const [index, input] of inputs.entries()) {
        const reading = normaliseReading(input, receivedAt);
        const extraJson = JSON.stringify(reading.extra);

        if (Buffer.byteLength(extraJson, 'utf8') > MAX_EXTRA_BYTES) {
          throw validationFailed([
            {
              path: inputs.length > 1 ? `readings.${index}` : '(body)',
              message: `Unrecognised fields exceed the ${MAX_EXTRA_BYTES / 1024} KiB limit.`,
            },
          ]);
        }

        const id = newId('rdg');
        ids.push(id);

        rows.push({
          id,
          device_id: device.id,
          user_id: device.user_id,
          recorded_at: reading.recordedAt,
          received_at: reading.receivedAt,
          clock_skew_ms: reading.clockSkewMs,
          latitude: reading.latitude,
          longitude: reading.longitude,
          altitude_m: reading.altitudeM,
          gps_accuracy_m: reading.gpsAccuracyM,
          ...reading.tires,
          ambient_temp_c: reading.ambientTempC,
          humidity_pct: reading.humidityPct,
          barometric_pressure_hpa: reading.barometricPressureHpa,
          accel_x_g: reading.accelXG,
          accel_y_g: reading.accelYG,
          accel_z_g: reading.accelZG,
          battery_voltage_v: reading.batteryVoltageV,
          extra: extraJson,
          created_at: reading.receivedAt,
        });
      }

      insertMany(rows);

      db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(
        receivedAt.toISOString(),
        device.id,
      );

      reply.code(201);
      return {
        accepted: rows.length,
        received_at: receivedAt.toISOString(),
        ids,
      };
    },
  );
}
