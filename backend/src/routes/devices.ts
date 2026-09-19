/**
 * Device listing — read-only over HTTP.
 *
 * There is intentionally no endpoint here that creates, rotates, or deletes a
 * device. This installation has no user accounts, so any such endpoint would be
 * reachable by anyone who found the API: they could mint themselves a device
 * key and post whatever they liked, which would make the ingest key pointless.
 *
 * Provisioning is therefore a local operation against the database:
 *
 *   npm run device -- add "Pico-01 · Trail Rig"
 *   npm run device -- rotate dev_xxxxxxxx
 *   npm run device -- remove dev_xxxxxxxx
 *
 * That keeps the one credential that matters — the ability to write readings —
 * in the hands of whoever can reach the server, rather than whoever can reach
 * the API.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../lib/errors.js';
import { parseOrThrow } from '../lib/validate.js';

interface DeviceRow {
  id: string;
  name: string;
  key_prefix: string;
  notes: string | null;
  created_at: string;
  key_rotated_at: string | null;
  last_seen_at: string | null;
  reading_count: number;
  last_reading_at: string | null;
}

const idParamsSchema = z.object({ id: z.string().min(1).max(64) }).strict();

const serialise = (row: DeviceRow) => ({
  id: row.id,
  name: row.name,
  // The prefix is not secret: it identifies which key a device holds without
  // revealing any of it.
  key_prefix: row.key_prefix,
  notes: row.notes,
  created_at: row.created_at,
  key_rotated_at: row.key_rotated_at,
  last_seen_at: row.last_seen_at,
  reading_count: row.reading_count,
  last_reading_at: row.last_reading_at,
});

const SELECT_DEVICE = `
  SELECT d.id, d.name, d.key_prefix, d.notes, d.created_at, d.key_rotated_at, d.last_seen_at,
         (SELECT COUNT(*) FROM readings r WHERE r.device_id = d.id) AS reading_count,
         (SELECT MAX(r.recorded_at) FROM readings r WHERE r.device_id = d.id) AS last_reading_at
    FROM devices d
`;

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  const db = app.db;

  app.get('/api/devices', async () => {
    const rows = db
      .prepare(`${SELECT_DEVICE} ORDER BY d.created_at ASC`)
      .all() as DeviceRow[];

    return { devices: rows.map(serialise) };
  });

  app.get('/api/devices/:id', async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);

    const row = db.prepare(`${SELECT_DEVICE} WHERE d.id = ?`).get(id) as DeviceRow | undefined;

    if (!row) throw notFound('Device not found.');
    return { device: serialise(row) };
  });
}
