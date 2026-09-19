/**
 * Display formatting.
 *
 * Telemetry is full of nulls — a sensor that was not fitted, a GPS fix that was
 * not acquired. Every formatter here takes `number | null | undefined` and
 * returns an em dash rather than "NaN" or "null", so a missing reading looks
 * deliberately absent instead of broken.
 */

export const EMPTY = '—';

const numberFormatters = new Map<string, Intl.NumberFormat>();

function formatter(digits: number): Intl.NumberFormat {
  const key = String(digits);
  let cached = numberFormatters.get(key);
  if (!cached) {
    cached = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    numberFormatters.set(key, cached);
  }
  return cached;
}

export function isPresent(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatNumber(value: number | null | undefined, digits = 1): string {
  return isPresent(value) ? formatter(digits).format(value) : EMPTY;
}

/** Compact form for large counts: 1,284 · 12.9K · 4.2M. */
export function formatCount(value: number | null | undefined): string {
  if (!isPresent(value)) return EMPTY;
  if (Math.abs(value) < 10_000) return new Intl.NumberFormat().format(value);
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export interface UnitSpec {
  readonly unit: string;
  readonly digits: number;
  readonly label: string;
}

/** Display metadata per metric, so units are never hardcoded at a call site. */
export const UNITS = {
  ambient_temp_c: { unit: '°C', digits: 1, label: 'Ambient temperature' },
  humidity_pct: { unit: '%', digits: 1, label: 'Humidity' },
  barometric_pressure_hpa: { unit: 'hPa', digits: 1, label: 'Barometric pressure' },
  battery_voltage_v: { unit: 'V', digits: 2, label: 'Battery voltage' },
  accel_x_g: { unit: 'g', digits: 3, label: 'Acceleration X' },
  accel_y_g: { unit: 'g', digits: 3, label: 'Acceleration Y' },
  accel_z_g: { unit: 'g', digits: 3, label: 'Acceleration Z' },
  altitude_m: { unit: 'm', digits: 1, label: 'Altitude' },
  gps_accuracy_m: { unit: 'm', digits: 1, label: 'GPS accuracy' },
  clock_skew_ms: { unit: 'ms', digits: 0, label: 'Clock skew' },
  tire_fl_pressure_kpa: { unit: 'kPa', digits: 1, label: 'Front-left pressure' },
  tire_fr_pressure_kpa: { unit: 'kPa', digits: 1, label: 'Front-right pressure' },
  tire_rl_pressure_kpa: { unit: 'kPa', digits: 1, label: 'Rear-left pressure' },
  tire_rr_pressure_kpa: { unit: 'kPa', digits: 1, label: 'Rear-right pressure' },
  tire_fl_temp_c: { unit: '°C', digits: 1, label: 'Front-left temperature' },
  tire_fr_temp_c: { unit: '°C', digits: 1, label: 'Front-right temperature' },
  tire_rl_temp_c: { unit: '°C', digits: 1, label: 'Rear-left temperature' },
  tire_rr_temp_c: { unit: '°C', digits: 1, label: 'Rear-right temperature' },
} as const satisfies Record<string, UnitSpec>;

export type UnitKey = keyof typeof UNITS;

export function unitFor(metric: string): UnitSpec {
  return (UNITS as Record<string, UnitSpec>)[metric] ?? { unit: '', digits: 2, label: metric };
}

/** "18.4 °C" — value and unit together, or an em dash. */
export function formatMetric(metric: string, value: number | null | undefined): string {
  const spec = unitFor(metric);
  if (!isPresent(value)) return EMPTY;
  const formatted = formatNumber(value, spec.digits);
  return spec.unit ? `${formatted} ${spec.unit}` : formatted;
}

export function formatCoordinate(value: number | null | undefined, digits = 5): string {
  return isPresent(value) ? value.toFixed(digits) : EMPTY;
}

/** "42.33980, -71.08920" */
export function formatLatLon(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): string {
  if (!isPresent(latitude) || !isPresent(longitude)) return EMPTY;
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

/** kPa → psi, for readers who think in psi. */
export function kpaToPsi(kpa: number | null | undefined): number | null {
  return isPresent(kpa) ? kpa * 0.1450377 : null;
}

export function celsiusToFahrenheit(celsius: number | null | undefined): number | null {
  return isPresent(celsius) ? celsius * 1.8 + 32 : null;
}

/** Signed duration, for clock skew: "+2.1 s", "-340 ms". */
export function formatSkew(milliseconds: number | null | undefined): string {
  if (!isPresent(milliseconds)) return EMPTY;
  const sign = milliseconds >= 0 ? '+' : '-';
  const magnitude = Math.abs(milliseconds);
  if (magnitude < 1000) return `${sign}${Math.round(magnitude)} ms`;
  if (magnitude < 60_000) return `${sign}${(magnitude / 1000).toFixed(1)} s`;
  return `${sign}${(magnitude / 60_000).toFixed(1)} min`;
}

/** Magnitude of the three-axis acceleration vector. */
export function accelerationMagnitude(
  x: number | null | undefined,
  y: number | null | undefined,
  z: number | null | undefined,
): number | null {
  if (!isPresent(x) || !isPresent(y) || !isPresent(z)) return null;
  return Math.sqrt(x * x + y * y + z * z);
}

/**
 * Render an arbitrary JSON value from the `extra` blob as a display string.
 *
 * Always returns a string, so the value reaches React as text and is escaped.
 * Objects and arrays are serialised rather than stringified to "[object Object]".
 */
export function formatUnknown(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return EMPTY;

  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      return Number.isFinite(value) ? String(value) : EMPTY;
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      try {
        return JSON.stringify(value);
      } catch {
        return EMPTY;
      }
  }
}

/** Sentence-case a snake_case key for display: "rssi_dbm" → "Rssi dbm". */
export function humaniseKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
