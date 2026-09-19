/**
 * The data layer.
 *
 * Every read and write in the application goes through this module. No
 * component touches IndexedDB directly, which is the same rule the app followed
 * when this was an HTTP client — the storage moved, the boundary did not.
 *
 * Readings are held in a sorted in-memory array alongside IndexedDB. Queries
 * then filter and aggregate synchronously, which keeps the dashboard responsive
 * while the range selector and search box change on every keystroke. IndexedDB
 * remains the durable copy; the array is a cache rebuilt on load and after any
 * mutation.
 */
import {
  STORE,
  clear,
  getAll,
  getMeta,
  put,
  putMany,
  remove,
  setMeta,
} from './db';
import type {
  Design,
  DesignParams,
  Device,
  MetricName,
  PageInfo,
  Reading,
  SeriesBucket,
  SeriesPoint,
  SeriesResponse,
  StatsResponse,
  TirePosition,
} from './types';
import { METRIC_NAMES, TIRE_POSITIONS } from './types';

export class DataError extends Error {
  /** Underlying failure, for the console. Never rendered to the user. */
  readonly detail?: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = 'DataError';
    this.detail = detail;
  }
}

/**
 * Upper bound on stored readings.
 *
 * The in-memory cache trades memory for query speed, so the ceiling is real
 * rather than arbitrary: 100,000 readings is roughly 40 MB resident, which a
 * laptop absorbs and a phone just about tolerates.
 */
export const MAX_READINGS = 100_000;

// ---------------------------------------------------------------------------
// Persisted record shapes
// ---------------------------------------------------------------------------

interface DeviceRecord {
  id: string;
  name: string;
  notes: string | null;
  created_at: string;
}

/** Stored flat, mirroring the backend's table, so exports interoperate. */
export interface ReadingRecord {
  id: string;
  device_id: string;
  recorded_at: string;
  received_at: string;
  clock_skew_ms: number;
  latitude: number;
  longitude: number;
  altitude_m: number | null;
  gps_accuracy_m: number | null;
  tire_fl_pressure_kpa: number | null;
  tire_fl_temp_c: number | null;
  tire_fr_pressure_kpa: number | null;
  tire_fr_temp_c: number | null;
  tire_rl_pressure_kpa: number | null;
  tire_rl_temp_c: number | null;
  tire_rr_pressure_kpa: number | null;
  tire_rr_temp_c: number | null;
  ambient_temp_c: number | null;
  humidity_pct: number | null;
  barometric_pressure_hpa: number | null;
  accel_x_g: number | null;
  accel_y_g: number | null;
  accel_z_g: number | null;
  battery_voltage_v: number | null;
  extra: Record<string, unknown>;
}

interface DesignRecord {
  id: string;
  name: string;
  params: DesignParams;
  latitude: number | null;
  longitude: number | null;
  place_label: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

interface Cache {
  /** Ascending by recorded_at, so range slicing and charting need no re-sort. */
  readings: ReadingRecord[];
  devices: DeviceRecord[];
}

let cache: Cache | null = null;
let loading: Promise<Cache> | null = null;

/** Notified after any mutation so open views can refresh. */
type ChangeListener = () => void;
const listeners = new Set<ChangeListener>();

export function onDataChange(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyChanged(): void {
  for (const listener of listeners) listener();
}

function invalidate(): void {
  cache = null;
  loading = null;
  notifyChanged();
}

async function load(): Promise<Cache> {
  if (cache) return cache;

  loading ??= (async () => {
    const [readings, devices] = await Promise.all([
      getAll<ReadingRecord>(STORE.readings),
      getAll<DeviceRecord>(STORE.devices),
    ]);

    readings.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
    devices.sort((a, b) => a.created_at.localeCompare(b.created_at));

    cache = { readings, devices };
    return cache;
  })();

  return loading;
}

/** Drop the cache without touching storage. Used after an external import. */
export function refresh(): void {
  invalidate();
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

const TIRE_KEY: Record<TirePosition, 'fl' | 'fr' | 'rl' | 'rr'> = {
  front_left: 'fl',
  front_right: 'fr',
  rear_left: 'rl',
  rear_right: 'rr',
};

function toReading(record: ReadingRecord, deviceName: string): Reading {
  const tires = {} as Reading['tires'];
  for (const position of TIRE_POSITIONS) {
    const key = TIRE_KEY[position];
    tires[position] = {
      pressure_kpa: record[`tire_${key}_pressure_kpa`],
      temp_c: record[`tire_${key}_temp_c`],
    };
  }

  return {
    id: record.id,
    device_id: record.device_id,
    device_name: deviceName,
    recorded_at: record.recorded_at,
    received_at: record.received_at,
    clock_skew_ms: record.clock_skew_ms,
    location: {
      latitude: record.latitude,
      longitude: record.longitude,
      altitude_m: record.altitude_m,
      gps_accuracy_m: record.gps_accuracy_m,
    },
    tires,
    sensors: {
      ambient_temp_c: record.ambient_temp_c,
      humidity_pct: record.humidity_pct,
      barometric_pressure_hpa: record.barometric_pressure_hpa,
      accel_x_g: record.accel_x_g,
      accel_y_g: record.accel_y_g,
      accel_z_g: record.accel_z_g,
      battery_voltage_v: record.battery_voltage_v,
    },
    extra: record.extra ?? {},
  };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export interface ReadingFilters {
  device_id?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
}

function matches(
  record: ReadingRecord,
  filters: ReadingFilters,
  deviceNames: Map<string, string>,
): boolean {
  if (filters.device_id && record.device_id !== filters.device_id) return false;
  if (filters.from && record.recorded_at < filters.from) return false;
  if (filters.to && record.recorded_at > filters.to) return false;

  if (filters.q) {
    const needle = filters.q.toLowerCase();
    const haystack = `${record.id} ${deviceNames.get(record.device_id) ?? ''} ${JSON.stringify(
      record.extra ?? {},
    )}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}

function deviceNameMap(devices: DeviceRecord[]): Map<string, string> {
  return new Map(devices.map((device) => [device.id, device.name]));
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export async function listDevices(_signal?: AbortSignal): Promise<{ devices: Device[] }> {
  const { devices, readings } = await load();

  const stats = new Map<string, { count: number; first: string; last: string }>();
  for (const reading of readings) {
    const existing = stats.get(reading.device_id);
    if (existing) {
      existing.count += 1;
      existing.last = reading.recorded_at;
    } else {
      stats.set(reading.device_id, {
        count: 1,
        first: reading.recorded_at,
        last: reading.recorded_at,
      });
    }
  }

  return {
    devices: devices.map((device) => {
      const entry = stats.get(device.id);
      return {
        id: device.id,
        name: device.name,
        notes: device.notes,
        created_at: device.created_at,
        reading_count: entry?.count ?? 0,
        first_reading_at: entry?.first ?? null,
        last_reading_at: entry?.last ?? null,
      };
    }),
  };
}

export async function createDevice(input: { name: string; notes?: string | null }): Promise<Device> {
  const name = input.name.trim();
  if (!name) throw new DataError('Give the device a name.');
  if (name.length > 80) throw new DataError('Keep the name under 80 characters.');

  const record: DeviceRecord = {
    id: newId('dev'),
    name,
    notes: input.notes?.trim() || null,
    created_at: new Date().toISOString(),
  };

  await put(STORE.devices, record);
  invalidate();

  return {
    ...record,
    reading_count: 0,
    first_reading_at: null,
    last_reading_at: null,
  };
}

export async function updateDevice(
  id: string,
  input: { name?: string; notes?: string | null },
): Promise<void> {
  const { devices } = await load();
  const existing = devices.find((device) => device.id === id);
  if (!existing) throw new DataError('Device not found.');

  const next: DeviceRecord = {
    ...existing,
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
  };

  if (!next.name) throw new DataError('Give the device a name.');

  await put(STORE.devices, next);
  invalidate();
}

/** Removing a device removes its readings too — nothing else references them. */
export async function deleteDevice(id: string): Promise<{ removedReadings: number }> {
  const { readings } = await load();
  const doomed = readings.filter((reading) => reading.device_id === id);

  for (const reading of doomed) {
    await remove(STORE.readings, reading.id);
  }
  await remove(STORE.devices, id);
  invalidate();

  return { removedReadings: doomed.length };
}

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

export type SortColumn =
  | 'recorded_at'
  | 'received_at'
  | 'ambient_temp_c'
  | 'humidity_pct'
  | 'battery_voltage_v'
  | 'barometric_pressure_hpa'
  | 'clock_skew_ms';

export interface ListReadingsParams extends ReadingFilters {
  sort?: SortColumn;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export async function listReadings(
  params: ListReadingsParams = {},
  _signal?: AbortSignal,
): Promise<{ readings: Reading[]; page: PageInfo }> {
  const { readings, devices } = await load();
  const names = deviceNameMap(devices);

  const { sort = 'recorded_at', order = 'desc', limit = 50, offset = 0 } = params;

  const filtered = readings.filter((record) => matches(record, params, names));

  const direction = order === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    const left = a[sort];
    const right = b[sort];

    // Nulls sort last regardless of direction: a missing reading is not
    // "smaller" than a present one, it is absent.
    if (left === null && right === null) return a.id.localeCompare(b.id);
    if (left === null) return 1;
    if (right === null) return -1;

    if (typeof left === 'string' && typeof right === 'string') {
      return left.localeCompare(right) * direction;
    }
    return ((left as number) - (right as number)) * direction;
  });

  const page = filtered.slice(offset, offset + limit);

  return {
    readings: page.map((record) => toReading(record, names.get(record.device_id) ?? 'Unknown device')),
    page: {
      total: filtered.length,
      limit,
      offset,
      has_more: offset + page.length < filtered.length,
    },
  };
}

export async function getReading(
  id: string,
  _signal?: AbortSignal,
): Promise<{ reading: Reading; neighbours: { newer_id: string | null; older_id: string | null } }> {
  const { readings, devices } = await load();
  const names = deviceNameMap(devices);

  const index = readings.findIndex((record) => record.id === id);
  if (index === -1) throw new DataError('Reading not found.');

  const record = readings[index]!;

  // `readings` is ascending, so neighbours within the same device are the
  // nearest entries either side that share a device_id.
  let olderId: string | null = null;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (readings[i]!.device_id === record.device_id) {
      olderId = readings[i]!.id;
      break;
    }
  }

  let newerId: string | null = null;
  for (let i = index + 1; i < readings.length; i += 1) {
    if (readings[i]!.device_id === record.device_id) {
      newerId = readings[i]!.id;
      break;
    }
  }

  return {
    reading: toReading(record, names.get(record.device_id) ?? 'Unknown device'),
    neighbours: { newer_id: newerId, older_id: olderId },
  };
}

export async function getStats(
  filters: ReadingFilters = {},
  _signal?: AbortSignal,
): Promise<StatsResponse> {
  const { readings, devices } = await load();
  const names = deviceNameMap(devices);
  const filtered = readings.filter((record) => matches(record, filters, names));

  const metrics = {} as StatsResponse['metrics'];
  for (const metric of METRIC_NAMES) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let n = 0;

    for (const record of filtered) {
      const value = record[metric as keyof ReadingRecord];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
      sum += value;
      n += 1;
    }

    metrics[metric] = {
      avg: n > 0 ? sum / n : null,
      min: n > 0 ? min : null,
      max: n > 0 ? max : null,
      count: n,
    };
  }

  const deviceIds = new Set(filtered.map((record) => record.device_id));

  return {
    total: filtered.length,
    device_count: deviceIds.size,
    first_recorded_at: filtered[0]?.recorded_at ?? null,
    last_recorded_at: filtered[filtered.length - 1]?.recorded_at ?? null,
    last_received_at:
      filtered.length > 0
        ? filtered.reduce((latest, record) =>
            record.received_at > latest.received_at ? record : latest,
          ).received_at
        : null,
    metrics,
  };
}

/** Truncate an ISO instant to the start of its bucket. */
function bucketKey(recordedAt: string, bucket: Exclude<SeriesBucket, 'raw'>): string {
  switch (bucket) {
    case 'minute':
      return `${recordedAt.slice(0, 17)}00Z`;
    case 'hour':
      return `${recordedAt.slice(0, 14)}00:00Z`;
    case 'day':
      return `${recordedAt.slice(0, 11)}00:00:00Z`;
  }
}

export async function getSeries(
  params: ReadingFilters & { metrics: MetricName[]; bucket?: SeriesBucket; limit?: number },
  _signal?: AbortSignal,
): Promise<SeriesResponse> {
  const { readings, devices } = await load();
  const names = deviceNameMap(devices);
  const { metrics, bucket = 'hour', limit = 500 } = params;

  const filtered = readings.filter((record) => matches(record, params, names));

  if (bucket === 'raw') {
    const slice = filtered.slice(-limit);
    return {
      bucket,
      metrics,
      points: slice.map((record) => {
        const point: SeriesPoint = { bucket: record.recorded_at };
        for (const metric of metrics) {
          const value = record[metric as keyof ReadingRecord];
          point[metric] = typeof value === 'number' ? value : null;
        }
        return point;
      }),
    };
  }

  const buckets = new Map<string, { sums: Map<MetricName, number>; counts: Map<MetricName, number>; n: number }>();

  for (const record of filtered) {
    const key = bucketKey(record.recorded_at, bucket);
    let entry = buckets.get(key);
    if (!entry) {
      entry = { sums: new Map(), counts: new Map(), n: 0 };
      buckets.set(key, entry);
    }
    entry.n += 1;

    for (const metric of metrics) {
      const value = record[metric as keyof ReadingRecord];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      entry.sums.set(metric, (entry.sums.get(metric) ?? 0) + value);
      entry.counts.set(metric, (entry.counts.get(metric) ?? 0) + 1);
    }
  }

  const ordered = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-limit);

  return {
    bucket,
    metrics,
    points: ordered.map(([key, entry]) => {
      const point: SeriesPoint = { bucket: key, sample_count: entry.n };
      for (const metric of metrics) {
        const count = entry.counts.get(metric) ?? 0;
        point[metric] = count > 0 ? (entry.sums.get(metric) ?? 0) / count : null;
      }
      return point;
    }),
  };
}

/** Raw records for export, in ascending time order. */
export async function readingRecordsFor(filters: ReadingFilters = {}): Promise<ReadingRecord[]> {
  const { readings, devices } = await load();
  const names = deviceNameMap(devices);
  return readings.filter((record) => matches(record, filters, names));
}

export async function addReadings(
  records: ReadingRecord[],
  onProgress?: (written: number, total: number) => void,
): Promise<void> {
  const existing = (await load()).readings.length;
  if (existing + records.length > MAX_READINGS) {
    throw new DataError(
      `That would exceed the ${MAX_READINGS.toLocaleString()} reading limit for browser storage. ` +
        'Export and clear some history first.',
    );
  }

  await putMany(STORE.readings, records, onProgress);
  invalidate();
}

export async function deleteAllReadings(): Promise<void> {
  await clear([STORE.readings]);
  invalidate();
}

// ---------------------------------------------------------------------------
// Designs
// ---------------------------------------------------------------------------

export const MAX_DESIGNS = 500;

export async function listDesigns(_signal?: AbortSignal): Promise<{ designs: Design[] }> {
  const designs = await getAll<DesignRecord>(STORE.designs);
  designs.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { designs };
}

export async function getDesign(id: string, _signal?: AbortSignal): Promise<{ design: Design }> {
  const designs = await getAll<DesignRecord>(STORE.designs);
  const design = designs.find((entry) => entry.id === id);
  if (!design) throw new DataError('Design not found.');
  return { design };
}

export interface DesignInput {
  name: string;
  params: DesignParams;
  latitude?: number | null;
  longitude?: number | null;
  place_label?: string | null;
}

export async function createDesign(input: DesignInput): Promise<{ design: Design }> {
  const designs = await getAll<DesignRecord>(STORE.designs);
  if (designs.length >= MAX_DESIGNS) {
    throw new DataError(`You have reached the limit of ${MAX_DESIGNS} saved designs.`);
  }

  const name = input.name.trim();
  if (!name) throw new DataError('Give the design a name.');

  const now = new Date().toISOString();
  const design: DesignRecord = {
    id: newId('dsn'),
    name: name.slice(0, 80),
    params: input.params,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    place_label: input.place_label ?? null,
    created_at: now,
    updated_at: now,
  };

  await put(STORE.designs, design);
  notifyChanged();
  return { design };
}

export async function updateDesign(
  id: string,
  input: Partial<DesignInput>,
): Promise<{ design: Design }> {
  const { design } = await getDesign(id);

  const next: DesignRecord = {
    ...(design as DesignRecord),
    ...(input.name !== undefined ? { name: input.name.trim().slice(0, 80) } : {}),
    ...(input.params !== undefined ? { params: input.params } : {}),
    ...(input.latitude !== undefined ? { latitude: input.latitude ?? null } : {}),
    ...(input.longitude !== undefined ? { longitude: input.longitude ?? null } : {}),
    ...(input.place_label !== undefined ? { place_label: input.place_label ?? null } : {}),
    updated_at: new Date().toISOString(),
  };

  if (!next.name) throw new DataError('Give the design a name.');

  await put(STORE.designs, next);
  notifyChanged();
  return { design: next };
}

export async function deleteDesign(id: string): Promise<void> {
  await remove(STORE.designs, id);
  notifyChanged();
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

export interface Backup {
  format: 'stone-backup';
  version: 1;
  exported_at: string;
  devices: DeviceRecord[];
  readings: ReadingRecord[];
  designs: DesignRecord[];
}

export async function exportAll(): Promise<Backup> {
  const { readings, devices } = await load();
  const designs = await getAll<DesignRecord>(STORE.designs);

  return {
    format: 'stone-backup',
    version: 1,
    exported_at: new Date().toISOString(),
    devices,
    readings,
    designs,
  };
}

/**
 * Restore a backup.
 *
 * `replace` wipes first; otherwise records merge by id, so re-importing the
 * same file is idempotent rather than duplicating everything.
 */
export async function importBackup(
  backup: unknown,
  options: { replace?: boolean } = {},
): Promise<{ devices: number; readings: number; designs: number }> {
  if (!backup || typeof backup !== 'object') {
    throw new DataError('That file is not a Stone backup.');
  }

  const candidate = backup as Partial<Backup>;
  if (candidate.format !== 'stone-backup') {
    throw new DataError('That file is not a Stone backup.');
  }

  const devices = Array.isArray(candidate.devices) ? candidate.devices : [];
  const readings = Array.isArray(candidate.readings) ? candidate.readings : [];
  const designs = Array.isArray(candidate.designs) ? candidate.designs : [];

  if (readings.length > MAX_READINGS) {
    throw new DataError(
      `That backup holds ${readings.length.toLocaleString()} readings, over the ` +
        `${MAX_READINGS.toLocaleString()} limit for browser storage.`,
    );
  }

  if (options.replace) {
    await clear([STORE.devices, STORE.readings, STORE.designs]);
  }

  await putMany(STORE.devices, devices);
  await putMany(STORE.readings, readings);
  await putMany(STORE.designs, designs);
  await setMeta('sampleLoaded', true);

  invalidate();
  return { devices: devices.length, readings: readings.length, designs: designs.length };
}

export async function clearEverything(): Promise<void> {
  await clear([STORE.devices, STORE.readings, STORE.designs, STORE.meta]);
  invalidate();
}

export { getMeta, setMeta };

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * Prefixed, roughly time-ordered identifier.
 *
 * Mirrors the backend's format so records move between the two without
 * rewriting keys.
 */
export function newId(prefix: 'dev' | 'rdg' | 'dsn'): string {
  let time = Date.now();
  let timePart = '';
  for (let i = 0; i < 8; i += 1) {
    timePart = ALPHABET[time % 32]! + timePart;
    time = Math.floor(time / 32);
  }

  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let randomPart = '';
  for (const byte of bytes) randomPart += ALPHABET[byte % 32]!;

  return `${prefix}_${timePart}${randomPart}`;
}
