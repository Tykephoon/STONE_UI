/**
 * Saved stone designs, and the share links that point at one of them.
 *
 * With no user accounts, designs are a single shared library: anyone who can
 * reach the API can list, create, edit, and delete them. A share link is
 * therefore a stable permalink rather than a grant of access — it is still
 * useful for referring to one design, and still revocable, but it no longer
 * protects anything.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createDesignSchema, updateDesignSchema } from '../domain/design.js';
import { sha256 } from '../lib/crypto.js';
import { conflict, notFound } from '../lib/errors.js';
import { newId, newSecret } from '../lib/ids.js';
import { parseOrThrow } from '../lib/validate.js';

interface DesignRow {
  id: string;
  name: string;
  params: string;
  latitude: number | null;
  longitude: number | null;
  place_label: string | null;
  created_at: string;
  updated_at: string;
}

const idParamsSchema = z.object({ id: z.string().min(1).max(64) }).strict();

/**
 * Library ceiling, so a scripted client cannot fill the volume.
 *
 * With no accounts this is the only backstop on design writes, alongside the
 * global HTTP rate limit.
 */
const MAX_DESIGNS = 200;

function serialise(row: DesignRow) {
  return {
    id: row.id,
    name: row.name,
    // Stored as validated JSON; parsed here so clients get an object, not a string.
    params: JSON.parse(row.params) as unknown,
    latitude: row.latitude,
    longitude: row.longitude,
    place_label: row.place_label,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function designRoutes(app: FastifyInstance): Promise<void> {
  const db = app.db;

  app.get('/api/designs', async (request) => {

    const rows = db
      .prepare(
        `SELECT d.id, d.name, d.params, d.latitude, d.longitude, d.place_label,
                d.created_at, d.updated_at
           FROM designs d
          ORDER BY d.updated_at DESC`,
      )
      .all() as DesignRow[];

    const shareCounts = db
      .prepare(
        `SELECT s.design_id, COUNT(*) AS n
           FROM design_shares s
          WHERE s.revoked_at IS NULL
          GROUP BY s.design_id`,
      )
      .all() as { design_id: string; n: number }[];

    const shared = new Map(shareCounts.map((row) => [row.design_id, row.n]));

    return {
      designs: rows.map((row) => ({ ...serialise(row), share_count: shared.get(row.id) ?? 0 })),
    };
  });

  app.get('/api/designs/:id', async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);

    const row = db
      .prepare(
        `SELECT id, name, params, latitude, longitude, place_label, created_at, updated_at
           FROM designs WHERE id = ?`,
      )
      .get(id) as DesignRow | undefined;

    if (!row) throw notFound('Design not found.');
    return { design: serialise(row) };
  });

  app.post('/api/designs', async (request, reply) => {
    const body = parseOrThrow(createDesignSchema, request.body);

    const count = (db.prepare('SELECT COUNT(*) AS n FROM designs').get() as { n: number }).n;

    if (count >= MAX_DESIGNS) {
      throw conflict(`The library is limited to ${MAX_DESIGNS} designs.`);
    }

    const id = newId('dsn');
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO designs (id, name, params, latitude, longitude, place_label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      body.name,
      JSON.stringify(body.params),
      body.latitude ?? null,
      body.longitude ?? null,
      body.place_label ?? null,
      now,
      now,
    );

    reply.code(201);
    return {
      design: {
        id,
        name: body.name,
        params: body.params,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        place_label: body.place_label ?? null,
        created_at: now,
        updated_at: now,
      },
    };
  });

  app.put('/api/designs/:id', async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const body = parseOrThrow(updateDesignSchema, request.body);

    const exists = db.prepare('SELECT id FROM designs WHERE id = ?').get(id);
    if (!exists) throw notFound('Design not found.');

    const fields: string[] = [];
    const values: unknown[] = [];

    if (body.name !== undefined) {
      fields.push('name = ?');
      values.push(body.name);
    }
    if (body.params !== undefined) {
      fields.push('params = ?');
      values.push(JSON.stringify(body.params));
    }
    if (body.latitude !== undefined) {
      fields.push('latitude = ?');
      values.push(body.latitude ?? null);
    }
    if (body.longitude !== undefined) {
      fields.push('longitude = ?');
      values.push(body.longitude ?? null);
    }
    if (body.place_label !== undefined) {
      fields.push('place_label = ?');
      values.push(body.place_label ?? null);
    }

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());

    db.prepare(`UPDATE designs SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);

    const row = db
      .prepare(
        `SELECT id, name, params, latitude, longitude, place_label, created_at, updated_at
           FROM designs WHERE id = ?`,
      )
      .get(id) as DesignRow;

    return { design: serialise(row) };
  });

  app.delete('/api/designs/:id', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);

    const result = db.prepare('DELETE FROM designs WHERE id = ?').run(id);

    if (result.changes === 0) throw notFound('Design not found.');

    reply.code(204);
    return null;
  });

  /**
   * Mint a share link.
   *
   * The token is returned once and stored only as a hash. It identifies a
   * design — not a user, not a session — so it can never be widened into
   * anything else.
   */
  app.post('/api/designs/:id/share', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);

    const exists = db.prepare('SELECT id FROM designs WHERE id = ?').get(id);
    if (!exists) throw notFound('Design not found.');

    const token = newSecret(24);
    db.prepare(
      'INSERT INTO design_shares (token_hash, design_id, created_at) VALUES (?, ?, ?)',
    ).run(sha256(token), id, new Date().toISOString());

    reply.code(201);
    return { share_token: token };
  });

  app.delete('/api/designs/:id/share', async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);

    const exists = db.prepare('SELECT id FROM designs WHERE id = ?').get(id);
    if (!exists) throw notFound('Design not found.');

    const result = db
      .prepare(
        'UPDATE design_shares SET revoked_at = ? WHERE design_id = ? AND revoked_at IS NULL',
      )
      .run(new Date().toISOString(), id);

    return { revoked: result.changes };
  });

  /**
   * Read a shared design by token.
   *
   * Returns the geometry parameters and nothing else — no internal id, no
   * device data, no sibling designs.
   */
  app.get(
    '/api/share/:token',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const { token } = parseOrThrow(
        z.object({ token: z.string().min(16).max(128) }).strict(),
        request.params,
      );

      const row = db
        .prepare(
          `SELECT d.id, d.name, d.params, d.latitude, d.longitude, d.place_label,
                  d.created_at, d.updated_at
             FROM design_shares s
             JOIN designs d ON d.id = s.design_id
            WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
        )
        .get(sha256(token)) as DesignRow | undefined;

      if (!row) throw notFound('This link is no longer available.');

      return {
        design: {
          name: row.name,
          params: JSON.parse(row.params) as unknown,
          latitude: row.latitude,
          longitude: row.longitude,
          place_label: row.place_label,
          updated_at: row.updated_at,
        },
      };
    },
  );
}
