/**
 * Reading queries: list, detail, aggregate statistics, time series, export.
 *
 * Every statement in this file filters on `user_id`. Column and metric names
 * that reach SQL come from allowlists, never from request strings, because
 * identifiers cannot be parameterised.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TIRE_COLUMN_KEY, TIRE_POSITIONS } from '../domain/reading.js';
import { notFound } from '../lib/errors.js';
import { parseOrThrow } from '../lib/validate.js';

export interface ReadingRow {
  id: string;
  device_id: string;
  device_name: string;
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
  extra: string;
}

/** Sortable columns. Anything not in this map is rejected before reaching SQL. */
const SORT_COLUMNS = {
  recorded_at: 'r.recorded_at',
  received_at: 'r.received_at',
  ambient_temp_c: 'r.ambient_temp_c',
  humidity_pct: 'r.humidity_pct',
  battery_voltage_v: 'r.battery_voltage_v',
  barometric_pressure_hpa: 'r.barometric_pressure_hpa',
  clock_skew_ms: 'r.clock_skew_ms',
} as const;

/** Numeric columns that can be charted or aggregated. */
export const METRIC_COLUMNS = {
  ambient_temp_c: 'ambient_temp_c',
  humidity_pct: 'humidity_pct',
  barometric_pressure_hpa: 'barometric_pressure_hpa',
  battery_voltage_v: 'battery_voltage_v',
  accel_x_g: 'accel_x_g',
  accel_y_g: 'accel_y_g',
  accel_z_g: 'accel_z_g',
  altitude_m: 'altitude_m',
  gps_accuracy_m: 'gps_accuracy_m',
  clock_skew_ms: 'clock_skew_ms',
  tire_fl_pressure_kpa: 'tire_fl_pressure_kpa',
  tire_fr_pressure_kpa: 'tire_fr_pressure_kpa',
  tire_rl_pressure_kpa: 'tire_rl_pressure_kpa',
  tire_rr_pressure_kpa: 'tire_rr_pressure_kpa',
  tire_fl_temp_c: 'tire_fl_temp_c',
  tire_fr_temp_c: 'tire_fr_temp_c',
  tire_rl_temp_c: 'tire_rl_temp_c',
  tire_rr_temp_c: 'tire_rr_temp_c',
} as const;

export type MetricName = keyof typeof METRIC_COLUMNS;

const listQuerySchema = z
  .object({
    device_id: z.string().max(64).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    q: z.string().trim().max(120).optional(),
    sort: z.enum(Object.keys(SORT_COLUMNS) as [keyof typeof SORT_COLUMNS]).default('recorded_at'),
    order: z.enum(['asc', 'desc']).default('desc'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strip();

const statsQuerySchema = z
  .object({
    device_id: z.string().max(64).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strip();

const seriesQuerySchema = statsQuerySchema.extend({
  metrics: z
    .string()
    .default('ambient_temp_c')
    .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))
    .pipe(
      z
        .array(z.enum(Object.keys(METRIC_COLUMNS) as [MetricName, ...MetricName[]]))
        .min(1)
        .max(8),
    ),
  bucket: z.enum(['raw', 'minute', 'hour', 'day']).default('hour'),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

/**
 * SQLite `strftime` patterns per bucket. Fixed strings selected by an enum, so
 * no caller input is interpolated.
 */
const BUCKET_FORMAT: Record<'minute' | 'hour' | 'day', string> = {
  minute: '%Y-%m-%dT%H:%M:00Z',
  hour: '%Y-%m-%dT%H:00:00Z',
  day: '%Y-%m-%dT00:00:00Z',
};

interface Filters {
  userId: string;
  deviceId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
}

/** Builds the shared WHERE fragment. `user_id` is always the first condition. */
function buildWhere(filters: Filters): { clause: string; params: unknown[] } {
  const conditions = ['r.user_id = ?'];
  const params: unknown[] = [filters.userId];

  if (filters.deviceId) {
    conditions.push('r.device_id = ?');
    params.push(filters.deviceId);
  }
  if (filters.from) {
    conditions.push('r.recorded_at >= ?');
    params.push(new Date(filters.from).toISOString());
  }
  if (filters.to) {
    conditions.push('r.recorded_at <= ?');
    params.push(new Date(filters.to).toISOString());
  }
  if (filters.q) {
    // Free-text across the identifier, the device name, and the raw extras
    // blob, which is where device-specific labels tend to live.
    conditions.push('(r.id LIKE ? OR d.name LIKE ? OR r.extra LIKE ?)');
    const pattern = `%${filters.q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    params.push(pattern, pattern, pattern);
  }

  return { clause: conditions.join(' AND '), params };
}

const SELECT_COLUMNS = `
  r.id, r.device_id, d.name AS device_name,
  r.recorded_at, r.received_at, r.clock_skew_ms,
  r.latitude, r.longitude, r.altitude_m, r.gps_accuracy_m,
  r.tire_fl_pressure_kpa, r.tire_fl_temp_c,
  r.tire_fr_pressure_kpa, r.tire_fr_temp_c,
  r.tire_rl_pressure_kpa, r.tire_rl_temp_c,
  r.tire_rr_pressure_kpa, r.tire_rr_temp_c,
  r.ambient_temp_c, r.humidity_pct, r.barometric_pressure_hpa,
  r.accel_x_g, r.accel_y_g, r.accel_z_g, r.battery_voltage_v,
  r.extra
`;

function parseExtra(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A corrupt blob must not take down the whole list response.
    return {};
  }
}

export function serialiseReading(row: ReadingRow) {
  const tires: Record<string, { pressure_kpa: number | null; temp_c: number | null }> = {};
  for (const position of TIRE_POSITIONS) {
    const key = TIRE_COLUMN_KEY[position] as 'fl' | 'fr' | 'rl' | 'rr';
    tires[position] = {
      pressure_kpa: row[`tire_${key}_pressure_kpa`],
      temp_c: row[`tire_${key}_temp_c`],
    };
  }

  return {
    id: row.id,
    device_id: row.device_id,
    device_name: row.device_name,
    recorded_at: row.recorded_at,
    received_at: row.received_at,
    clock_skew_ms: row.clock_skew_ms,
    location: {
      latitude: row.latitude,
      longitude: row.longitude,
      altitude_m: row.altitude_m,
      gps_accuracy_m: row.gps_accuracy_m,
    },
    tires,
    sensors: {
      ambient_temp_c: row.ambient_temp_c,
      humidity_pct: row.humidity_pct,
      barometric_pressure_hpa: row.barometric_pressure_hpa,
      accel_x_g: row.accel_x_g,
      accel_y_g: row.accel_y_g,
      accel_z_g: row.accel_z_g,
      battery_voltage_v: row.battery_voltage_v,
    },
    extra: parseExtra(row.extra),
  };
}

export async function readingRoutes(app: FastifyInstance): Promise<void> {
  const db = app.db;

  app.get('/api/readings', async (request) => {
    app.requireUser(request);
    const query = parseOrThrow(listQuerySchema, request.query);

    const { clause, params } = buildWhere({
      userId: request.auth.user.id,
      deviceId: query.device_id,
      from: query.from,
      to: query.to,
      q: query.q,
    });

    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM readings r JOIN devices d ON d.id = r.device_id WHERE ${clause}`,
        )
        .get(...params) as { n: number }
    ).n;

    const sortColumn = SORT_COLUMNS[query.sort];
    const direction = query.order === 'asc' ? 'ASC' : 'DESC';

    const rows = db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
           FROM readings r
           JOIN devices d ON d.id = r.device_id
          WHERE ${clause}
          ORDER BY ${sortColumn} ${direction}, r.id ${direction}
          LIMIT ? OFFSET ?`,
      )
      .all(...params, query.limit, query.offset) as ReadingRow[];

    return {
      readings: rows.map(serialiseReading),
      page: {
        total,
        limit: query.limit,
        offset: query.offset,
        has_more: query.offset + rows.length < total,
      },
    };
  });

  /**
   * Aggregates for the dashboard summary. Registered before `/:id` so the
   * literal path is not captured by the parameterised route.
   */
  app.get('/api/readings/stats', async (request) => {
    app.requireUser(request);
    const query = parseOrThrow(statsQuerySchema, request.query);

    const { clause, params } = buildWhere({
      userId: request.auth.user.id,
      deviceId: query.device_id,
      from: query.from,
      to: query.to,
    });

    const metricNames = Object.keys(METRIC_COLUMNS) as MetricName[];
    const aggregates = metricNames
      .map(
        (metric) =>
          `AVG(r.${METRIC_COLUMNS[metric]}) AS avg_${metric},
           MIN(r.${METRIC_COLUMNS[metric]}) AS min_${metric},
           MAX(r.${METRIC_COLUMNS[metric]}) AS max_${metric},
           COUNT(r.${METRIC_COLUMNS[metric]}) AS n_${metric}`,
      )
      .join(',\n');

    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
                MIN(r.recorded_at) AS first_recorded_at,
                MAX(r.recorded_at) AS last_recorded_at,
                MAX(r.received_at) AS last_received_at,
                COUNT(DISTINCT r.device_id) AS device_count,
                ${aggregates}
           FROM readings r
           JOIN devices d ON d.id = r.device_id
          WHERE ${clause}`,
      )
      .get(...params) as Record<string, number | string | null>;

    const metrics: Record<string, { avg: number | null; min: number | null; max: number | null; count: number }> = {};
    for (const metric of metricNames) {
      metrics[metric] = {
        avg: (row[`avg_${metric}`] as number | null) ?? null,
        min: (row[`min_${metric}`] as number | null) ?? null,
        max: (row[`max_${metric}`] as number | null) ?? null,
        count: (row[`n_${metric}`] as number) ?? 0,
      };
    }

    return {
      total: row.total as number,
      device_count: row.device_count as number,
      first_recorded_at: row.first_recorded_at as string | null,
      last_recorded_at: row.last_recorded_at as string | null,
      last_received_at: row.last_received_at as string | null,
      metrics,
    };
  });

  /** Bucketed series for charts. */
  app.get('/api/readings/series', async (request) => {
    app.requireUser(request);
    const query = parseOrThrow(seriesQuerySchema, request.query);

    const { clause, params } = buildWhere({
      userId: request.auth.user.id,
      deviceId: query.device_id,
      from: query.from,
      to: query.to,
    });

    if (query.bucket === 'raw') {
      const columns = query.metrics.map((metric) => `r.${METRIC_COLUMNS[metric]} AS ${metric}`).join(', ');
      const rows = db
        .prepare(
          `SELECT r.recorded_at AS bucket, ${columns}
             FROM readings r
             JOIN devices d ON d.id = r.device_id
            WHERE ${clause}
            ORDER BY r.recorded_at DESC
            LIMIT ?`,
        )
        .all(...params, query.limit) as Record<string, unknown>[];

      // Reversed so the series reads left-to-right in time.
      return { bucket: 'raw', metrics: query.metrics, points: rows.reverse() };
    }

    const format = BUCKET_FORMAT[query.bucket];
    const columns = query.metrics
      .map((metric) => `AVG(r.${METRIC_COLUMNS[metric]}) AS ${metric}`)
      .join(', ');

    const rows = db
      .prepare(
        `SELECT strftime('${format}', r.recorded_at) AS bucket,
                COUNT(*) AS sample_count,
                ${columns}
           FROM readings r
           JOIN devices d ON d.id = r.device_id
          WHERE ${clause}
          GROUP BY bucket
          ORDER BY bucket DESC
          LIMIT ?`,
      )
      .all(...params, query.limit) as Record<string, unknown>[];

    return { bucket: query.bucket, metrics: query.metrics, points: rows.reverse() };
  });

  /** CSV or JSON export of the current filter selection. */
  app.get('/api/readings/export', async (request, reply) => {
    app.requireUser(request);
    const query = parseOrThrow(
      statsQuerySchema.extend({
        format: z.enum(['csv', 'json']).default('csv'),
        limit: z.coerce.number().int().min(1).max(50_000).default(10_000),
      }),
      request.query,
    );

    const { clause, params } = buildWhere({
      userId: request.auth.user.id,
      deviceId: query.device_id,
      from: query.from,
      to: query.to,
    });

    const rows = db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
           FROM readings r
           JOIN devices d ON d.id = r.device_id
          WHERE ${clause}
          ORDER BY r.recorded_at DESC
          LIMIT ?`,
      )
      .all(...params, query.limit) as ReadingRow[];

    const stamp = new Date().toISOString().slice(0, 10);

    if (query.format === 'json') {
      reply.header('content-disposition', `attachment; filename="readings-${stamp}.json"`);
      return { readings: rows.map(serialiseReading) };
    }

    const headers = [
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
     * Any field that could be read as a formula is prefixed with an
     * apostrophe. Device names and the extras blob are user- and
     * device-controlled, and a spreadsheet will happily execute `=cmd|...`.
     */
    const escape = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      let text = String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };

    const lines = [
      headers.join(','),
      ...rows.map((row) => headers.map((header) => escape(row[header])).join(',')),
    ];

    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="readings-${stamp}.csv"`);
    return lines.join('\r\n');
  });

  app.get('/api/readings/:id', async (request) => {
    app.requireUser(request);
    const { id } = parseOrThrow(z.object({ id: z.string().min(1).max(64) }).strict(), request.params);

    const row = db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
           FROM readings r
           JOIN devices d ON d.id = r.device_id
          WHERE r.id = ? AND r.user_id = ?`,
      )
      .get(id, request.auth.user.id) as ReadingRow | undefined;

    if (!row) throw notFound('Reading not found.');

    // Neighbours let the detail page offer prev/next without a second request.
    const neighbours = db
      .prepare(
        `SELECT
           (SELECT r2.id FROM readings r2
             WHERE r2.user_id = ? AND r2.device_id = ? AND r2.recorded_at > ?
             ORDER BY r2.recorded_at ASC LIMIT 1) AS newer_id,
           (SELECT r3.id FROM readings r3
             WHERE r3.user_id = ? AND r3.device_id = ? AND r3.recorded_at < ?
             ORDER BY r3.recorded_at DESC LIMIT 1) AS older_id`,
      )
      .get(
        request.auth.user.id,
        row.device_id,
        row.recorded_at,
        request.auth.user.id,
        row.device_id,
        row.recorded_at,
      ) as { newer_id: string | null; older_id: string | null };

    return { reading: serialiseReading(row), neighbours };
  });
}
