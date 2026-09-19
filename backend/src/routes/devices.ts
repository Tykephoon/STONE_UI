/**
 * Device registration and key management.
 *
 * A device key is shown exactly once, at creation or rotation. Only its
 * SHA-256 is stored, so there is no "show me the key again" path — losing it
 * means rotating it, which is the correct trade.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sha256 } from '../lib/crypto.js';
import { notFound } from '../lib/errors.js';
import { newId, newSecret } from '../lib/ids.js';
import { parseOrThrow } from '../lib/validate.js';

const DEVICE_KEY_PREFIX = 'stk';

const createDeviceSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the device a name.').max(80, 'Keep the name under 80 characters.'),
    notes: z.string().trim().max(500).nullish(),
  })
  .strict();

const updateDeviceSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    notes: z.string().trim().max(500).nullish(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

const idParamsSchema = z.object({ id: z.string().min(1).max(64) }).strict();

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

function generateKey(): { key: string; hash: string; prefix: string } {
  const secret = newSecret(32);
  const key = `${DEVICE_KEY_PREFIX}_${secret}`;
  return {
    key,
    hash: sha256(key),
    // Enough to identify the key in a list, far too little to guess the rest.
    prefix: `${DEVICE_KEY_PREFIX}_${secret.slice(0, 6)}`,
  };
}

const serialise = (row: DeviceRow) => ({
  id: row.id,
  name: row.name,
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

  app.get('/api/devices', async (request) => {
    app.requireUser(request);

    const rows = db
      .prepare(`${SELECT_DEVICE} WHERE d.user_id = ? ORDER BY d.created_at ASC`)
      .all(request.auth.user.id) as DeviceRow[];

    return { devices: rows.map(serialise) };
  });

  app.get('/api/devices/:id', async (request) => {
    app.requireUser(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);

    // Ownership is part of the WHERE clause, not a check after the fetch, so
    // there is no path where a row is loaded and then conditionally hidden.
    const row = db
      .prepare(`${SELECT_DEVICE} WHERE d.id = ? AND d.user_id = ?`)
      .get(id, request.auth.user.id) as DeviceRow | undefined;

    if (!row) throw notFound('Device not found.');
    return { device: serialise(row) };
  });

  app.post('/api/devices', async (request, reply) => {
    app.requireUser(request);
    const body = parseOrThrow(createDeviceSchema, request.body);

    const id = newId('dev');
    const now = new Date().toISOString();
    const { key, hash, prefix } = generateKey();

    db.prepare(
      `INSERT INTO devices (id, user_id, name, key_hash, key_prefix, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, request.auth.user.id, body.name, hash, prefix, body.notes ?? null, now);

    reply.code(201);
    return {
      device: {
        id,
        name: body.name,
        key_prefix: prefix,
        notes: body.notes ?? null,
        created_at: now,
        key_rotated_at: null,
        last_seen_at: null,
        reading_count: 0,
        last_reading_at: null,
      },
      // The only time this value exists outside the device.
      device_key: key,
    };
  });

  app.patch('/api/devices/:id', async (request) => {
    app.requireUser(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const body = parseOrThrow(updateDeviceSchema, request.body);

    const owned = db
      .prepare('SELECT id FROM devices WHERE id = ? AND user_id = ?')
      .get(id, request.auth.user.id);
    if (!owned) throw notFound('Device not found.');

    const fields: string[] = [];
    const values: unknown[] = [];
    if (body.name !== undefined) {
      fields.push('name = ?');
      values.push(body.name);
    }
    if (body.notes !== undefined) {
      fields.push('notes = ?');
      values.push(body.notes ?? null);
    }

    db.prepare(`UPDATE devices SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(
      ...values,
      id,
      request.auth.user.id,
    );

    const row = db
      .prepare(`${SELECT_DEVICE} WHERE d.id = ? AND d.user_id = ?`)
      .get(id, request.auth.user.id) as DeviceRow;

    return { device: serialise(row) };
  });

  app.post('/api/devices/:id/rotate-key', async (request) => {
    app.requireUser(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);

    const owned = db
      .prepare('SELECT id FROM devices WHERE id = ? AND user_id = ?')
      .get(id, request.auth.user.id);
    if (!owned) throw notFound('Device not found.');

    const { key, hash, prefix } = generateKey();
    const now = new Date().toISOString();

    // The old hash is overwritten, so the previous key stops working the
    // instant this returns.
    db.prepare(
      'UPDATE devices SET key_hash = ?, key_prefix = ?, key_rotated_at = ? WHERE id = ? AND user_id = ?',
    ).run(hash, prefix, now, id, request.auth.user.id);

    return { device_key: key, key_prefix: prefix, key_rotated_at: now };
  });

  /**
   * Deleting a device cascades to its readings. Readings are immutable, but
   * immutable is not the same as undeletable — a user must be able to remove
   * their own data.
   */
  app.delete('/api/devices/:id', async (request, reply) => {
    app.requireUser(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);

    const result = db
      .prepare('DELETE FROM devices WHERE id = ? AND user_id = ?')
      .run(id, request.auth.user.id);

    if (result.changes === 0) throw notFound('Device not found.');

    reply.code(204);
    return null;
  });
}
