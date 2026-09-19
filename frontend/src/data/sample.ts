/**
 * First-run sample data.
 *
 * A brand-new visitor with an empty database would otherwise land on an empty
 * dashboard, which reads as broken rather than as new. This loads a bundled
 * snapshot of simulated telemetry once, records that it did so, and never
 * touches it again — so clearing the data stays cleared.
 *
 * The file lives in `public/` rather than being imported, so its ~175 kB
 * gzipped does not sit in the JavaScript bundle and is fetched only when the
 * database is actually empty.
 */
import { STORE, count, getMeta, putMany, setMeta } from './db';
import { refresh } from './store';
import type { ReadingRecord } from './store';

const SAMPLE_LOADED_KEY = 'sampleLoaded';

/** Compact on-disk shape; keys are short because the file is 2,000+ rows. */
interface CompactReading {
  i: string;
  d: string;
  t: string;
  r: string;
  la: number;
  lo: number;
  al: number | null;
  ac: number | null;
  tp: (number | null)[];
  tt: (number | null)[];
  at: number | null;
  hu: number | null;
  bp: number | null;
  ax: number | null;
  ay: number | null;
  az: number | null;
  bv: number | null;
  x: Record<string, unknown>;
}

interface SamplePayload {
  version: number;
  devices: { id: string; name: string; notes: string | null; created_at: string }[];
  readings: CompactReading[];
}

function expand(compact: CompactReading): ReadingRecord {
  const [flP, frP, rlP, rrP] = compact.tp;
  const [flT, frT, rlT, rrT] = compact.tt;

  return {
    id: compact.i,
    device_id: compact.d,
    recorded_at: compact.t,
    received_at: compact.r,
    clock_skew_ms: Date.parse(compact.r) - Date.parse(compact.t),
    latitude: compact.la,
    longitude: compact.lo,
    altitude_m: compact.al,
    gps_accuracy_m: compact.ac,
    tire_fl_pressure_kpa: flP ?? null,
    tire_fr_pressure_kpa: frP ?? null,
    tire_rl_pressure_kpa: rlP ?? null,
    tire_rr_pressure_kpa: rrP ?? null,
    tire_fl_temp_c: flT ?? null,
    tire_fr_temp_c: frT ?? null,
    tire_rl_temp_c: rlT ?? null,
    tire_rr_temp_c: rrT ?? null,
    ambient_temp_c: compact.at,
    humidity_pct: compact.hu,
    barometric_pressure_hpa: compact.bp,
    accel_x_g: compact.ax,
    accel_y_g: compact.ay,
    accel_z_g: compact.az,
    battery_voltage_v: compact.bv,
    extra: compact.x ?? {},
  };
}

/**
 * Load the sample once, if the database is empty and it has never been loaded.
 *
 * Returns whether anything was written. Failures are swallowed deliberately:
 * a missing or corrupt sample file must not stop the app from starting, it just
 * means an empty dashboard with a prompt to import.
 */
export async function ensureSampleData(): Promise<boolean> {
  try {
    if (await getMeta<boolean>(SAMPLE_LOADED_KEY)) return false;

    // Respect an existing database even if the flag is somehow absent.
    const [readings, devices] = await Promise.all([
      count(STORE.readings),
      count(STORE.devices),
    ]);
    if (readings > 0 || devices > 0) {
      await setMeta(SAMPLE_LOADED_KEY, true);
      return false;
    }

    const response = await fetch(`${import.meta.env.BASE_URL}data/sample-telemetry.json`);
    if (!response.ok) return false;

    const payload = (await response.json()) as SamplePayload;
    if (payload.version !== 1 || !Array.isArray(payload.readings)) return false;

    await putMany(STORE.devices, payload.devices);
    await putMany(STORE.readings, payload.readings.map(expand));
    await setMeta(SAMPLE_LOADED_KEY, true);

    refresh();
    return true;
  } catch {
    return false;
  }
}

/** Lets the settings panel offer the sample again after a wipe. */
export async function forgetSampleFlag(): Promise<void> {
  await setMeta(SAMPLE_LOADED_KEY, false);
}
