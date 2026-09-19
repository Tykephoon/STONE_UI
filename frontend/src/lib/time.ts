/**
 * Timestamp handling.
 *
 * Every instant crossing the API is UTC ISO-8601. Display is in the viewer's
 * local zone, and the zone is always named somewhere nearby, because telemetry
 * with an ambiguous timestamp is telemetry you cannot trust.
 */

export const LOCAL_TIME_ZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';

const dateTime = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const dateTimeShort = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const timeOnly = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateOnly = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? dateTime.format(date) : '—';
}

export function formatDateTimeShort(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? dateTimeShort.format(date) : '—';
}

export function formatTime(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? timeOnly.format(date) : '—';
}

export function formatDate(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? dateOnly.format(date) : '—';
}

/** Full precision including milliseconds and the UTC original — for detail views. */
export function formatPrecise(value: string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  const millis = String(date.getMilliseconds()).padStart(3, '0');
  return `${dateTime.format(date)}.${millis}`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

/** "3 minutes ago", "in 2 hours". */
export function formatRelative(
  value: string | number | Date | null | undefined,
  now: number = Date.now(),
): string {
  const date = toDate(value);
  if (!date) return '—';

  let duration = (date.getTime() - now) / 1000;

  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return relative.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }

  return relative.format(Math.round(duration), 'year');
}

/** "2 h 14 m" — an elapsed span, unsigned. */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.abs(milliseconds) / 1000);
  if (seconds < 60) return `${seconds} s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} m`;

  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

export type RangePreset = '1h' | '6h' | '24h' | '7d' | '30d' | '90d' | 'all';

export interface TimeRange {
  from?: string | undefined;
  to?: string | undefined;
}

export const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: '1h', label: 'Last hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
];

const PRESET_MS: Record<Exclude<RangePreset, 'all'>, number> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
};

export function rangeFromPreset(preset: RangePreset, now: number = Date.now()): TimeRange {
  if (preset === 'all') return {};
  return { from: new Date(now - PRESET_MS[preset]).toISOString() };
}

/**
 * Pick a bucket size that yields a readable number of points for the span.
 *
 * Charting 30 days of five-minute samples as raw points is ~8,600 marks in a
 * 600-pixel-wide plot: slow to render and impossible to read.
 */
export function bucketForRange(preset: RangePreset): 'raw' | 'minute' | 'hour' | 'day' {
  switch (preset) {
    case '1h':
      return 'raw';
    case '6h':
    case '24h':
      return 'minute';
    case '7d':
    case '30d':
      return 'hour';
    default:
      return 'day';
  }
}

/** Convert a `<input type="datetime-local">` value to a UTC ISO string. */
export function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Convert a UTC ISO string to a `<input type="datetime-local">` value. */
export function isoToLocalInput(value: string | undefined): string {
  const date = toDate(value);
  if (!date) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
