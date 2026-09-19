/**
 * Domain types.
 *
 * These describe what is stored in the browser and what the UI renders. They
 * intentionally match the optional backend's wire format, so a record exported
 * from here can be posted to it unchanged if the app ever grows a server.
 */

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
}

/**
 * A device is now just a label for grouping readings — there is no key,
 * because nothing authenticates to anything.
 */
export interface Device {
  id: string;
  name: string;
  notes: string | null;
  created_at: string;
  reading_count: number;
  first_reading_at: string | null;
  last_reading_at: string | null;
}

export const TIRE_POSITIONS = ['front_left', 'front_right', 'rear_left', 'rear_right'] as const;
export type TirePosition = (typeof TIRE_POSITIONS)[number];

export interface TireReading {
  pressure_kpa: number | null;
  temp_c: number | null;
}

export interface Reading {
  id: string;
  device_id: string;
  device_name: string;
  recorded_at: string;
  received_at: string;
  clock_skew_ms: number;
  location: {
    latitude: number;
    longitude: number;
    altitude_m: number | null;
    gps_accuracy_m: number | null;
  };
  tires: Record<TirePosition, TireReading>;
  sensors: {
    ambient_temp_c: number | null;
    humidity_pct: number | null;
    barometric_pressure_hpa: number | null;
    accel_x_g: number | null;
    accel_y_g: number | null;
    accel_z_g: number | null;
    battery_voltage_v: number | null;
  };
  /** Anything the device sent that the schema does not name. Always rendered as text. */
  extra: Record<string, unknown>;
}

export interface PageInfo {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface ReadingListResponse {
  readings: Reading[];
  page: PageInfo;
}

export interface ReadingDetailResponse {
  reading: Reading;
  neighbours: { newer_id: string | null; older_id: string | null };
}

export interface MetricSummary {
  avg: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

export const METRIC_NAMES = [
  'ambient_temp_c',
  'humidity_pct',
  'barometric_pressure_hpa',
  'battery_voltage_v',
  'accel_x_g',
  'accel_y_g',
  'accel_z_g',
  'altitude_m',
  'gps_accuracy_m',
  'clock_skew_ms',
  'tire_fl_pressure_kpa',
  'tire_fr_pressure_kpa',
  'tire_rl_pressure_kpa',
  'tire_rr_pressure_kpa',
  'tire_fl_temp_c',
  'tire_fr_temp_c',
  'tire_rl_temp_c',
  'tire_rr_temp_c',
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

export interface StatsResponse {
  total: number;
  device_count: number;
  first_recorded_at: string | null;
  last_recorded_at: string | null;
  last_received_at: string | null;
  metrics: Record<MetricName, MetricSummary>;
}

export type SeriesBucket = 'raw' | 'minute' | 'hour' | 'day';

export interface SeriesPoint {
  bucket: string;
  sample_count?: number;
  [metric: string]: string | number | null | undefined;
}

export interface SeriesResponse {
  bucket: SeriesBucket;
  metrics: MetricName[];
  points: SeriesPoint[];
}

/** Generator parameters. Mirrors `backend/src/domain/design.ts`, which validates them. */
export interface DesignParams {
  seed: string;
  dimensions: {
    length_mm: number;
    width_mm: number;
    height_mm: number;
  };
  form: {
    roundness: number;
    taper: number;
    asymmetry: number;
    flatten: number;
    bulge: number;
  };
  surface: {
    detail: number;
    grain: number;
    erosion: number;
    faceting: number;
    resolution: number;
  };
  material: {
    color: string;
    accentColor: string;
    roughness: number;
    metalness: number;
    speckle: number;
    clearcoat: number;
  };
}

export interface Design {
  id: string;
  name: string;
  params: DesignParams;
  latitude: number | null;
  longitude: number | null;
  place_label: string | null;
  created_at: string;
  updated_at: string;
}

export interface GeoResult {
  label: string;
  latitude: number;
  longitude: number;
  kind: string | null;
}
