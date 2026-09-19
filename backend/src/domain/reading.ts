/**
 * The reading contract.
 *
 * This is the authoritative validator. The SPA validates too, but only so the
 * user gets fast feedback — nothing reaches a table without passing through
 * here first.
 *
 * Ranges are physical plausibility bounds, not calibration limits: they exist
 * to reject garbage and transposed units (psi sent where kPa was expected), not
 * to silently clamp real readings. Out-of-range values are rejected with a
 * message naming the field, because a device author debugging a firmware
 * payload needs to know which key was wrong.
 */
import { z } from 'zod';

export const TIRE_POSITIONS = ['front_left', 'front_right', 'rear_left', 'rear_right'] as const;
export type TirePosition = (typeof TIRE_POSITIONS)[number];

/** Column-name fragment for each wheel, matching the `readings` table. */
export const TIRE_COLUMN_KEY: Record<TirePosition, string> = {
  front_left: 'fl',
  front_right: 'fr',
  rear_left: 'rl',
  rear_right: 'rr',
};

const optionalNumber = (min: number, max: number, unit: string) =>
  z
    .number({ invalid_type_error: `must be a number in ${unit}` })
    .finite('must be a finite number')
    .min(min, `must be at least ${min} ${unit}`)
    .max(max, `must be at most ${max} ${unit}`)
    .nullish();

const tireSchema = z
  .object({
    // 0–1400 kPa spans a bicycle tyre through to a heavy truck tyre.
    pressure_kpa: optionalNumber(0, 1400, 'kPa'),
    temp_c: optionalNumber(-60, 250, '°C'),
  })
  .strict();

const sensorsSchema = z
  .object({
    ambient_temp_c: optionalNumber(-90, 70, '°C'),
    humidity_pct: optionalNumber(0, 100, '%'),
    barometric_pressure_hpa: optionalNumber(300, 1100, 'hPa'),
    accel_x_g: optionalNumber(-32, 32, 'g'),
    accel_y_g: optionalNumber(-32, 32, 'g'),
    accel_z_g: optionalNumber(-32, 32, 'g'),
    battery_voltage_v: optionalNumber(0, 60, 'V'),
  })
  .strict();

/**
 * An ISO-8601 instant. `z.string().datetime()` rejects offsets by default;
 * offsets are allowed here because a device may report local time with a zone
 * rather than converting to UTC itself.
 */
const isoInstant = z
  .string()
  .datetime({ offset: true, message: 'must be an ISO-8601 timestamp, e.g. 2026-09-19T10:04:00Z' });

export const readingInputSchema = z
  .object({
    recorded_at: isoInstant,

    latitude: z
      .number({ required_error: 'latitude is required' })
      .finite()
      .min(-90, 'must be between -90 and 90')
      .max(90, 'must be between -90 and 90'),
    longitude: z
      .number({ required_error: 'longitude is required' })
      .finite()
      .min(-180, 'must be between -180 and 180')
      .max(180, 'must be between -180 and 180'),
    altitude_m: optionalNumber(-500, 20000, 'm'),
    gps_accuracy_m: optionalNumber(0, 100000, 'm'),

    tires: z
      .object({
        front_left: tireSchema.optional(),
        front_right: tireSchema.optional(),
        rear_left: tireSchema.optional(),
        rear_right: tireSchema.optional(),
      })
      .strict()
      .optional(),

    sensors: sensorsSchema.optional(),
  })
  // Unknown keys are kept rather than rejected: a device firmware revision that
  // adds a field should not start failing ingest, and the data should not be
  // silently dropped either. Everything unrecognised lands in `extra`.
  .passthrough();

export type ReadingInput = z.infer<typeof readingInputSchema>;

export const ingestBodySchema = z.union([
  readingInputSchema,
  z.object({ readings: z.array(readingInputSchema).min(1) }).strict(),
]);

const KNOWN_TOP_LEVEL_KEYS = new Set([
  'recorded_at',
  'latitude',
  'longitude',
  'altitude_m',
  'gps_accuracy_m',
  'tires',
  'sensors',
]);

/**
 * Split recognised fields from everything else. The remainder is stored as JSON
 * so no device data is lost, and the dashboard renders it in the raw view.
 */
export function extractExtra(input: ReadingInput): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      extra[key] = value;
    }
  }
  return extra;
}

/** Longest a single `extra` blob may be once serialised (64 KiB). */
export const MAX_EXTRA_BYTES = 64 * 1024;

export interface NormalisedReading {
  recordedAt: string;
  receivedAt: string;
  clockSkewMs: number;
  latitude: number;
  longitude: number;
  altitudeM: number | null;
  gpsAccuracyM: number | null;
  tires: Record<string, number | null>;
  ambientTempC: number | null;
  humidityPct: number | null;
  barometricPressureHpa: number | null;
  accelXG: number | null;
  accelYG: number | null;
  accelZG: number | null;
  batteryVoltageV: number | null;
  extra: Record<string, unknown>;
}

const nullish = (value: number | null | undefined): number | null =>
  value === undefined ? null : value;

export function normaliseReading(input: ReadingInput, receivedAt: Date): NormalisedReading {
  // Normalise the device's timestamp to UTC so every stored instant is
  // directly comparable regardless of the offset the device reported.
  const recorded = new Date(input.recorded_at);
  const recordedIso = recorded.toISOString();

  const tires: Record<string, number | null> = {};
  for (const position of TIRE_POSITIONS) {
    const key = TIRE_COLUMN_KEY[position];
    const value = input.tires?.[position];
    tires[`tire_${key}_pressure_kpa`] = nullish(value?.pressure_kpa);
    tires[`tire_${key}_temp_c`] = nullish(value?.temp_c);
  }

  const sensors = input.sensors;

  return {
    recordedAt: recordedIso,
    receivedAt: receivedAt.toISOString(),
    clockSkewMs: receivedAt.getTime() - recorded.getTime(),
    latitude: input.latitude,
    longitude: input.longitude,
    altitudeM: nullish(input.altitude_m),
    gpsAccuracyM: nullish(input.gps_accuracy_m),
    tires,
    ambientTempC: nullish(sensors?.ambient_temp_c),
    humidityPct: nullish(sensors?.humidity_pct),
    barometricPressureHpa: nullish(sensors?.barometric_pressure_hpa),
    accelXG: nullish(sensors?.accel_x_g),
    accelYG: nullish(sensors?.accel_y_g),
    accelZG: nullish(sensors?.accel_z_g),
    batteryVoltageV: nullish(sensors?.battery_voltage_v),
    extra: extractExtra(input),
  };
}
