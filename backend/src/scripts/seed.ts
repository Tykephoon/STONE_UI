/**
 * Development seed.
 *
 * Generates a few weeks of plausible telemetry so the dashboard has something
 * real to render before hardware exists. The data is simulated rather than
 * random: a vehicle drives a loop each weekday, tyre pressure tracks tyre
 * temperature through the ideal gas law, ambient temperature follows a diurnal
 * cycle, and the battery discharges and recharges across a trip. Random noise
 * alone produces charts that look wrong to anyone who has seen real telemetry.
 *
 * Usage:  npm run seed -- --email you@example.com --password 'correct horse battery staple'
 */
import { parseArgs } from 'node:util';
import { openDatabase } from '../db/index.js';
import { hashPassword, sha256 } from '../lib/crypto.js';
import { newId, newSecret } from '../lib/ids.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string', default: 'demo@stone.local' },
    password: { type: 'string' },
    days: { type: 'string', default: '21' },
    reset: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

/** Deterministic PRNG so repeated seeds produce comparable datasets. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(0x5745);

/** Box–Muller, for noise that clusters around a mean like a real sensor. */
function gaussian(mean: number, stdDev: number): number {
  const u = Math.max(random(), Number.EPSILON);
  const v = random();
  return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const round = (value: number, places = 2): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

interface RoutePoint {
  lat: number;
  lon: number;
}

/**
 * A closed loop through Boston. Interpolating around it gives readings that
 * trace a believable path on the map instead of a shotgun scatter.
 */
const ROUTE: RoutePoint[] = [
  { lat: 42.3398, lon: -71.0892 }, // Northeastern
  { lat: 42.3467, lon: -71.0972 }, // Fenway
  { lat: 42.3581, lon: -71.0936 }, // Back Bay
  { lat: 42.3601, lon: -71.0589 }, // Downtown
  { lat: 42.3656, lon: -71.0096 }, // East Boston
  { lat: 42.3399, lon: -71.0223 }, // South Boston
  { lat: 42.3312, lon: -71.0571 }, // Dorchester edge
  { lat: 42.3298, lon: -71.0836 }, // Roxbury
];

function interpolateRoute(progress: number): RoutePoint {
  const scaled = (progress % 1) * ROUTE.length;
  const index = Math.floor(scaled);
  const t = scaled - index;
  const from = ROUTE[index % ROUTE.length]!;
  const to = ROUTE[(index + 1) % ROUTE.length]!;
  return {
    lat: from.lat + (to.lat - from.lat) * t,
    lon: from.lon + (to.lon - from.lon) * t,
  };
}

const TIRE_KEYS = ['fl', 'fr', 'rl', 'rr'] as const;

interface DeviceProfile {
  name: string;
  notes: string;
  /** Cold inflation pressure in kPa, per wheel. */
  basePressure: Record<(typeof TIRE_KEYS)[number], number>;
  /** kPa lost per day — one wheel on device 2 has a slow leak. */
  leakPerDay: Record<(typeof TIRE_KEYS)[number], number>;
  intervalMinutes: number;
  batteryNominal: number;
  extra: (index: number) => Record<string, unknown>;
}

const PROFILES: DeviceProfile[] = [
  {
    name: 'Pico-01 · Trail Rig',
    notes: 'Raspberry Pi Pico W, BME280 + MPU-6050, four TPMS sensors.',
    basePressure: { fl: 227, fr: 227, rl: 234, rr: 234 },
    leakPerDay: { fl: 0, fr: 0, rl: 0, rr: 0 },
    intervalMinutes: 5,
    batteryNominal: 12.6,
    extra: (index) => ({
      firmware: '1.4.2',
      rssi_dbm: round(gaussian(-62, 7), 0),
      uptime_s: index * 300,
      sd_free_mb: round(7400 - index * 0.4, 1),
    }),
  },
  {
    name: 'Pico-02 · Fleet Van',
    notes: 'Second unit. Rear-left has a documented slow leak.',
    basePressure: { fl: 310, fr: 310, rl: 324, rr: 324 },
    leakPerDay: { fl: 0.1, fr: 0.05, rl: 2.4, rr: 0.1 },
    intervalMinutes: 10,
    batteryNominal: 13.8,
    extra: (index) => ({
      firmware: '1.3.9',
      rssi_dbm: round(gaussian(-71, 9), 0),
      uptime_s: index * 600,
      odometer_km: round(48120 + index * 0.9, 1),
      driver_tag: index % 3 === 0 ? 'night-shift' : 'day-shift',
    }),
  },
];

async function main(): Promise<void> {
  const db = openDatabase();
  const email = values.email!.trim().toLowerCase();
  const password = values.password ?? `demo-${newSecret(9)}`;
  const days = Math.max(1, Math.min(120, Number.parseInt(values.days!, 10) || 21));

  if (values.reset) {
    // Removing the user cascades to devices, readings, designs, and sessions.
    db.prepare('DELETE FROM users WHERE email = ?').run(email);
    console.log(`Removed any existing account for ${email}.`);
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as
    | { id: string }
    | undefined;

  if (existing) {
    console.error(
      `An account for ${email} already exists. Re-run with --reset to replace it, ` +
        'or pass a different --email.',
    );
    db.close();
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const userId = newId('usr');

  const passwordHash = await hashPassword(password);

  db.prepare(
    `INSERT INTO users (id, email, email_display, password_hash, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, email, values.email!, passwordHash, 'Demo Operator', now.toISOString(), now.toISOString());

  const insertReading = db.prepare(`
    INSERT INTO readings (
      id, device_id, user_id, recorded_at, received_at, clock_skew_ms,
      latitude, longitude, altitude_m, gps_accuracy_m,
      tire_fl_pressure_kpa, tire_fl_temp_c, tire_fr_pressure_kpa, tire_fr_temp_c,
      tire_rl_pressure_kpa, tire_rl_temp_c, tire_rr_pressure_kpa, tire_rr_temp_c,
      ambient_temp_c, humidity_pct, barometric_pressure_hpa,
      accel_x_g, accel_y_g, accel_z_g, battery_voltage_v, extra, created_at
    ) VALUES (
      @id, @device_id, @user_id, @recorded_at, @received_at, @clock_skew_ms,
      @latitude, @longitude, @altitude_m, @gps_accuracy_m,
      @tire_fl_pressure_kpa, @tire_fl_temp_c, @tire_fr_pressure_kpa, @tire_fr_temp_c,
      @tire_rl_pressure_kpa, @tire_rl_temp_c, @tire_rr_pressure_kpa, @tire_rr_temp_c,
      @ambient_temp_c, @humidity_pct, @barometric_pressure_hpa,
      @accel_x_g, @accel_y_g, @accel_z_g, @battery_voltage_v, @extra, @created_at
    )
  `);

  const summaries: { name: string; key: string; readings: number }[] = [];

  const seedAll = db.transaction(() => {
    for (const profile of PROFILES) {
      const deviceId = newId('dev');
      const secret = newSecret(32);
      const key = `stk_${secret}`;

      db.prepare(
        `INSERT INTO devices (id, user_id, name, key_hash, key_prefix, notes, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        deviceId,
        userId,
        profile.name,
        sha256(key),
        `stk_${secret.slice(0, 6)}`,
        profile.notes,
        new Date(now.getTime() - days * 86_400_000).toISOString(),
        now.toISOString(),
      );

      const rows = buildReadings(profile, deviceId, userId, now, days);
      for (const row of rows) insertReading.run(row);

      summaries.push({ name: profile.name, key, readings: rows.length });
    }
  });

  seedAll();
  db.close();

  console.log('\n  Seed complete.\n');
  console.log(`  Email     ${values.email}`);
  console.log(`  Password  ${password}`);
  console.log(`  Window    ${days} days\n`);
  for (const summary of summaries) {
    console.log(`  ${summary.name}`);
    console.log(`    readings   ${summary.readings.toLocaleString()}`);
    console.log(`    device key ${summary.key}`);
  }
  console.log('\n  Device keys are shown once. Copy them now if you want to POST test readings.\n');
}

function buildReadings(
  profile: DeviceProfile,
  deviceId: string,
  userId: string,
  now: Date,
  days: number,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const intervalMs = profile.intervalMinutes * 60_000;
  const start = now.getTime() - days * 86_400_000;

  let batteryCharge = 1;
  let index = 0;

  for (let time = start; time <= now.getTime(); time += intervalMs) {
    const timestamp = new Date(time);
    const hour = timestamp.getUTCHours() + timestamp.getUTCMinutes() / 60;
    const dayOfWeek = timestamp.getUTCDay();

    // The rig is driven on weekdays, roughly 07:00–18:00 UTC.
    const isWorkday = dayOfWeek !== 0 && dayOfWeek !== 6;
    const isDriving = isWorkday && hour > 7 && hour < 18;

    // Diurnal ambient swing plus a slow seasonal drift across the window.
    const dayProgress = (time - start) / (days * 86_400_000);
    const seasonal = -4 * dayProgress;
    const ambient = gaussian(
      11 + seasonal + 7 * Math.sin(((hour - 9) / 24) * 2 * Math.PI),
      0.8,
    );

    const progress = ((time - start) / 86_400_000) * 0.6;
    const point = isDriving
      ? interpolateRoute(progress)
      : { lat: ROUTE[0]!.lat + gaussian(0, 0.00004), lon: ROUTE[0]!.lon + gaussian(0, 0.00004) };

    // Tyres heat while rolling and cool towards ambient when parked.
    const tireHeating = isDriving ? 18 + gaussian(0, 3) : gaussian(1.5, 0.8);
    const elapsedDays = (time - start) / 86_400_000;

    const tires: Record<string, number> = {};
    for (const key of TIRE_KEYS) {
      const tireTemp = ambient + tireHeating + gaussian(0, 1.2);
      const cold = profile.basePressure[key] - profile.leakPerDay[key] * elapsedDays;
      // Gay-Lussac: absolute pressure scales with absolute temperature.
      const absoluteCold = cold + 101.3;
      const pressure =
        (absoluteCold * (tireTemp + 273.15)) / (20 + 273.15) - 101.3 + gaussian(0, 0.9);

      tires[`tire_${key}_pressure_kpa`] = round(pressure, 1);
      tires[`tire_${key}_temp_c`] = round(tireTemp, 1);
    }

    if (isDriving) {
      batteryCharge = Math.min(1, batteryCharge + 0.004);
    } else {
      batteryCharge = Math.max(0.55, batteryCharge - 0.0009);
    }

    const recordedAt = timestamp;
    // Devices drift. A few seconds of skew is normal and worth surfacing.
    const skewMs = Math.round(gaussian(1800, 900) + elapsedDays * 120);
    const receivedAt = new Date(time + Math.max(120, skewMs));

    rows.push({
      id: newId('rdg'),
      device_id: deviceId,
      user_id: userId,
      recorded_at: recordedAt.toISOString(),
      received_at: receivedAt.toISOString(),
      clock_skew_ms: receivedAt.getTime() - recordedAt.getTime(),
      latitude: round(point.lat, 6),
      longitude: round(point.lon, 6),
      altitude_m: round(gaussian(isDriving ? 18 : 12, 4), 1),
      gps_accuracy_m: round(Math.abs(gaussian(isDriving ? 6 : 3.5, 2)) + 1.5, 1),
      ...tires,
      ambient_temp_c: round(ambient, 1),
      humidity_pct: round(Math.min(99, Math.max(12, gaussian(62 - 12 * Math.sin((hour / 24) * 2 * Math.PI), 6))), 1),
      barometric_pressure_hpa: round(gaussian(1013 - 6 * Math.sin(dayProgress * 6), 1.6), 1),
      accel_x_g: round(isDriving ? gaussian(0, 0.22) : gaussian(0, 0.004), 3),
      accel_y_g: round(isDriving ? gaussian(0, 0.18) : gaussian(0, 0.004), 3),
      accel_z_g: round(isDriving ? gaussian(1, 0.12) : gaussian(1, 0.006), 3),
      battery_voltage_v: round(profile.batteryNominal * (0.86 + 0.14 * batteryCharge), 2),
      extra: JSON.stringify(profile.extra(index)),
      created_at: receivedAt.toISOString(),
    });

    index += 1;
  }

  return rows;
}

main().catch((cause) => {
  console.error('Seed failed:', cause);
  process.exit(1);
});
