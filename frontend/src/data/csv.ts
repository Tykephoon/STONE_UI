/**
 * CSV parsing, column mapping, and validation for manual imports.
 *
 * Written against the shape of files people actually have rather than one
 * canonical format: column names are matched through an alias table, only three
 * fields are required, and anything unrecognised is kept in `extra` rather than
 * discarded. A file exported from this app round-trips exactly.
 *
 * Validation mirrors the backend's Zod schema, including the physical
 * plausibility ranges — a tyre pressure of 2200 is a psi/kPa mix-up, not a
 * reading, and catching it at import is far cheaper than explaining a wrong
 * chart later.
 */
import { type ReadingRecord, newId } from './store';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * RFC 4180 parser: quoted fields, doubled quotes, embedded newlines, and both
 * line-ending conventions. Hand-written because the alternative is a dependency
 * for about sixty lines of logic.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  // A leading byte-order mark otherwise becomes part of the first header name.
  if (text.charCodeAt(0) === 0xfeff) index = 1;

  while (index < text.length) {
    const char = text[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }

    if (char === '\r' || char === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      // Consume CRLF as one break.
      index += char === '\r' && text[index + 1] === '\n' ? 2 : 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // Whatever is left when the text ends is the final field.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop trailing blank lines.
  return rows.filter((entry) => entry.length > 1 || (entry[0] ?? '').trim() !== '');
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

/** Canonical field → accepted header spellings, all compared normalised. */
const ALIASES: Record<string, string[]> = {
  recorded_at: ['recorded_at', 'recordedat', 'timestamp', 'time', 'datetime', 'date', 'ts'],
  received_at: ['received_at', 'receivedat', 'server_time'],
  device_id: ['device_id', 'deviceid', 'device'],
  device_name: ['device_name', 'devicename'],
  latitude: ['latitude', 'lat'],
  longitude: ['longitude', 'lon', 'lng', 'long'],
  altitude_m: ['altitude_m', 'altitude', 'alt', 'elevation', 'elevation_m'],
  gps_accuracy_m: ['gps_accuracy_m', 'gps_accuracy', 'accuracy', 'hdop_m'],

  tire_fl_pressure_kpa: ['tire_fl_pressure_kpa', 'fl_pressure', 'front_left_pressure', 'tyre_fl_pressure_kpa'],
  tire_fr_pressure_kpa: ['tire_fr_pressure_kpa', 'fr_pressure', 'front_right_pressure', 'tyre_fr_pressure_kpa'],
  tire_rl_pressure_kpa: ['tire_rl_pressure_kpa', 'rl_pressure', 'rear_left_pressure', 'tyre_rl_pressure_kpa'],
  tire_rr_pressure_kpa: ['tire_rr_pressure_kpa', 'rr_pressure', 'rear_right_pressure', 'tyre_rr_pressure_kpa'],
  tire_fl_temp_c: ['tire_fl_temp_c', 'fl_temp', 'front_left_temp', 'tyre_fl_temp_c'],
  tire_fr_temp_c: ['tire_fr_temp_c', 'fr_temp', 'front_right_temp', 'tyre_fr_temp_c'],
  tire_rl_temp_c: ['tire_rl_temp_c', 'rl_temp', 'rear_left_temp', 'tyre_rl_temp_c'],
  tire_rr_temp_c: ['tire_rr_temp_c', 'rr_temp', 'rear_right_temp', 'tyre_rr_temp_c'],

  ambient_temp_c: ['ambient_temp_c', 'ambient_temp', 'temperature', 'temp_c', 'temp'],
  humidity_pct: ['humidity_pct', 'humidity', 'rh'],
  barometric_pressure_hpa: ['barometric_pressure_hpa', 'pressure_hpa', 'barometric_pressure', 'baro'],
  accel_x_g: ['accel_x_g', 'accel_x', 'ax'],
  accel_y_g: ['accel_y_g', 'accel_y', 'ay'],
  accel_z_g: ['accel_z_g', 'accel_z', 'az'],
  battery_voltage_v: ['battery_voltage_v', 'battery_voltage', 'battery', 'vbat'],
};

const normalise = (header: string): string =>
  header.trim().toLowerCase().replace(/[\s.-]+/g, '_').replace(/[()]/g, '');

const LOOKUP = new Map<string, string>();
for (const [canonical, spellings] of Object.entries(ALIASES)) {
  for (const spelling of spellings) LOOKUP.set(spelling, canonical);
}

export interface ColumnMapping {
  /** Header index → canonical field name. */
  readonly recognised: Map<number, string>;
  /** Header index → original name, for columns that go into `extra`. */
  readonly extras: Map<number, string>;
  readonly missingRequired: string[];
}

export function mapColumns(headers: string[]): ColumnMapping {
  const recognised = new Map<number, string>();
  const extras = new Map<number, string>();
  const seen = new Set<string>();

  headers.forEach((header, index) => {
    const canonical = LOOKUP.get(normalise(header));
    // A duplicated column is kept as an extra rather than silently overwriting.
    if (canonical && !seen.has(canonical)) {
      recognised.set(index, canonical);
      seen.add(canonical);
    } else if (header.trim()) {
      extras.set(index, header.trim());
    }
  });

  const missingRequired = ['recorded_at', 'latitude', 'longitude'].filter(
    (field) => !seen.has(field),
  );

  return { recognised, extras, missingRequired };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Physical plausibility bounds, matching the backend's schema. */
const RANGES: Record<string, [number, number, string]> = {
  latitude: [-90, 90, '°'],
  longitude: [-180, 180, '°'],
  altitude_m: [-500, 20000, 'm'],
  gps_accuracy_m: [0, 100000, 'm'],
  tire_fl_pressure_kpa: [0, 1400, 'kPa'],
  tire_fr_pressure_kpa: [0, 1400, 'kPa'],
  tire_rl_pressure_kpa: [0, 1400, 'kPa'],
  tire_rr_pressure_kpa: [0, 1400, 'kPa'],
  tire_fl_temp_c: [-60, 250, '°C'],
  tire_fr_temp_c: [-60, 250, '°C'],
  tire_rl_temp_c: [-60, 250, '°C'],
  tire_rr_temp_c: [-60, 250, '°C'],
  ambient_temp_c: [-90, 70, '°C'],
  humidity_pct: [0, 100, '%'],
  barometric_pressure_hpa: [300, 1100, 'hPa'],
  accel_x_g: [-32, 32, 'g'],
  accel_y_g: [-32, 32, 'g'],
  accel_z_g: [-32, 32, 'g'],
  battery_voltage_v: [0, 60, 'V'],
};

export interface RowIssue {
  /** 1-based line number in the source file, counting the header. */
  line: number;
  field: string;
  message: string;
}

export interface ParseResult {
  readings: ReadingRecord[];
  issues: RowIssue[];
  /** Device names seen in the file, so the importer can create them. */
  deviceNames: Set<string>;
  mapping: ColumnMapping;
  totalRows: number;
}

/**
 * Accepts ISO-8601, and the `YYYY-MM-DD HH:MM:SS` form spreadsheets produce.
 * Returns a UTC ISO string, or null if it cannot be understood.
 */
export function parseTimestamp(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  // A space-separated datetime with no zone is read as UTC rather than local,
  // so the same file imports identically wherever it is opened.
  const spaceSeparated = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?(\.\d+)?)$/.exec(value);
  if (spaceSeparated) {
    const parsed = new Date(`${spaceSeparated[1]}T${spaceSeparated[2]}Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  // Reject values Date accepted but that are clearly not timestamps, such as a
  // bare integer being read as a year.
  if (!/[-:T]/.test(value)) return null;

  return parsed.toISOString();
}

function parseNumber(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  // Strip thousands separators and a trailing unit a spreadsheet may have left.
  const cleaned = value.replace(/,/g, '').replace(/[^\d.eE+-]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

const EMPTY_READING = (): Omit<ReadingRecord, 'id' | 'device_id' | 'recorded_at' | 'received_at' | 'clock_skew_ms' | 'latitude' | 'longitude'> => ({
  altitude_m: null,
  gps_accuracy_m: null,
  tire_fl_pressure_kpa: null,
  tire_fl_temp_c: null,
  tire_fr_pressure_kpa: null,
  tire_fr_temp_c: null,
  tire_rl_pressure_kpa: null,
  tire_rl_temp_c: null,
  tire_rr_pressure_kpa: null,
  tire_rr_temp_c: null,
  ambient_temp_c: null,
  humidity_pct: null,
  barometric_pressure_hpa: null,
  accel_x_g: null,
  accel_y_g: null,
  accel_z_g: null,
  battery_voltage_v: null,
  extra: {},
});

/** Ceiling on issues collected, so a catastrophically wrong file stays usable. */
const MAX_ISSUES = 100;

export function parseReadingsCsv(text: string, defaultDeviceId: string): ParseResult {
  const rows = parseCsv(text);
  const issues: RowIssue[] = [];
  const readings: ReadingRecord[] = [];
  const deviceNames = new Set<string>();

  if (rows.length === 0) {
    return {
      readings,
      issues: [{ line: 1, field: '(file)', message: 'The file is empty.' }],
      deviceNames,
      mapping: { recognised: new Map(), extras: new Map(), missingRequired: [] },
      totalRows: 0,
    };
  }

  const headers = rows[0]!;
  const mapping = mapColumns(headers);

  if (mapping.missingRequired.length > 0) {
    return {
      readings,
      issues: [
        {
          line: 1,
          field: '(header)',
          message: `Missing required column${
            mapping.missingRequired.length > 1 ? 's' : ''
          }: ${mapping.missingRequired.join(', ')}.`,
        },
      ],
      deviceNames,
      mapping,
      totalRows: rows.length - 1,
    };
  }

  const addIssue = (issue: RowIssue) => {
    if (issues.length < MAX_ISSUES) issues.push(issue);
  };

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    const line = rowIndex + 1;

    // Blank lines in the middle of a file are skipped, not reported.
    if (row.every((cell) => cell.trim() === '')) continue;

    const record: Record<string, unknown> = { ...EMPTY_READING() };
    const extra: Record<string, unknown> = {};
    let rowFailed = false;

    let recordedAt: string | null = null;
    let receivedAt: string | null = null;
    let deviceName: string | null = null;
    let explicitId: string | null = null;
    let explicitDeviceId: string | null = null;

    for (const [columnIndex, field] of mapping.recognised) {
      const raw = row[columnIndex] ?? '';

      if (field === 'recorded_at') {
        recordedAt = parseTimestamp(raw);
        if (!recordedAt) {
          addIssue({
            line,
            field,
            message: raw.trim()
              ? `"${raw.trim().slice(0, 32)}" is not a timestamp this can read.`
              : 'A timestamp is required.',
          });
          rowFailed = true;
        }
        continue;
      }

      if (field === 'received_at') {
        receivedAt = parseTimestamp(raw);
        continue;
      }

      if (field === 'device_name') {
        deviceName = raw.trim() || null;
        continue;
      }

      if (field === 'device_id') {
        explicitDeviceId = raw.trim() || null;
        continue;
      }

      const value = parseNumber(raw);

      if (value === null) {
        // Latitude and longitude are the only numbers that must be present.
        if (field === 'latitude' || field === 'longitude') {
          addIssue({ line, field, message: 'A numeric value is required.' });
          rowFailed = true;
        }
        continue;
      }

      const range = RANGES[field];
      if (range && (value < range[0] || value > range[1])) {
        addIssue({
          line,
          field,
          message: `${value} is outside the plausible range ${range[0]} to ${range[1]} ${range[2]}.`,
        });
        rowFailed = true;
        continue;
      }

      record[field] = value;
    }

    for (const [columnIndex, header] of mapping.extras) {
      const raw = (row[columnIndex] ?? '').trim();
      if (!raw) continue;
      // Keep the original text; a number that parses cleanly is stored as one.
      const asNumber = Number(raw);
      extra[header] = raw !== '' && Number.isFinite(asNumber) && /^[\d.eE+-]+$/.test(raw) ? asNumber : raw;
    }

    // An `extra` column from our own export arrives as a JSON string; unwrap it.
    if (typeof extra.extra === 'string') {
      try {
        const parsed: unknown = JSON.parse(extra.extra as string);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          delete extra.extra;
          Object.assign(extra, parsed);
        }
      } catch {
        // Leave it as a string if it is not valid JSON.
      }
    }

    if (typeof extra.id === 'string' && extra.id.trim()) {
      explicitId = extra.id.trim();
      delete extra.id;
    }

    if (rowFailed || !recordedAt) continue;

    if (deviceName) deviceNames.add(deviceName);

    const received = receivedAt ?? recordedAt;

    readings.push({
      ...(record as Omit<ReadingRecord, 'id' | 'device_id' | 'recorded_at' | 'received_at' | 'clock_skew_ms' | 'latitude' | 'longitude'>),
      // Reuse the source id when there is one, so re-importing a file updates
      // rows rather than duplicating them.
      id: explicitId ?? newId('rdg'),
      device_id: explicitDeviceId ?? defaultDeviceId,
      recorded_at: recordedAt,
      received_at: received,
      clock_skew_ms: Date.parse(received) - Date.parse(recordedAt),
      latitude: record.latitude as number,
      longitude: record.longitude as number,
      extra,
    });
  }

  return { readings, issues, deviceNames, mapping, totalRows: rows.length - 1 };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const EXPORT_COLUMNS = [
  'id',
  'device_id',
  'device_name',
  'recorded_at',
  'received_at',
  'clock_skew_ms',
  'latitude',
  'longitude',
  'altitude_m',
  'gps_accuracy_m',
  'tire_fl_pressure_kpa',
  'tire_fl_temp_c',
  'tire_fr_pressure_kpa',
  'tire_fr_temp_c',
  'tire_rl_pressure_kpa',
  'tire_rl_temp_c',
  'tire_rr_pressure_kpa',
  'tire_rr_temp_c',
  'ambient_temp_c',
  'humidity_pct',
  'barometric_pressure_hpa',
  'accel_x_g',
  'accel_y_g',
  'accel_z_g',
  'battery_voltage_v',
  'extra',
] as const;

/**
 * Serialise to CSV.
 *
 * Cells that begin with a formula character are prefixed with an apostrophe:
 * device names and the extras blob are user-supplied, and a spreadsheet will
 * execute `=cmd|...` on open.
 */
export function toCsv(records: ReadingRecord[], deviceNames: Map<string, string>): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };

  const lines = [EXPORT_COLUMNS.join(',')];

  for (const record of records) {
    lines.push(
      EXPORT_COLUMNS.map((column) => {
        if (column === 'device_name') return escape(deviceNames.get(record.device_id) ?? '');
        return escape(record[column as keyof ReadingRecord]);
      }).join(','),
    );
  }

  return lines.join('\r\n');
}

/** A minimal, valid file users can fill in — offered as a download on the import page. */
export function templateCsv(): string {
  const now = new Date();
  const earlier = new Date(now.getTime() - 300_000);

  const row = (time: Date, lat: number, lon: number, temp: number) =>
    [
      time.toISOString(),
      lat,
      lon,
      '14.2',
      '4.5',
      '228.4',
      '31.2',
      '229.1',
      '30.8',
      '235.0',
      '33.4',
      '234.2',
      '33.1',
      temp,
      '61.2',
      '1014.2',
      '0.02',
      '-0.01',
      '1.00',
      '12.4',
    ].join(',');

  return [
    [
      'recorded_at',
      'latitude',
      'longitude',
      'altitude_m',
      'gps_accuracy_m',
      'tire_fl_pressure_kpa',
      'tire_fl_temp_c',
      'tire_fr_pressure_kpa',
      'tire_fr_temp_c',
      'tire_rl_pressure_kpa',
      'tire_rl_temp_c',
      'tire_rr_pressure_kpa',
      'tire_rr_temp_c',
      'ambient_temp_c',
      'humidity_pct',
      'barometric_pressure_hpa',
      'accel_x_g',
      'accel_y_g',
      'accel_z_g',
      'battery_voltage_v',
    ].join(','),
    row(earlier, 42.3398, -71.0892, 18.1),
    row(now, 42.3401, -71.0885, 18.4),
  ].join('\r\n');
}
