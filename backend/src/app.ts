/**
 * Fastify application factory.
 *
 * Exported separately from the server bootstrap so tests can build an app
 * against an in-memory database and drive it with `app.inject()` — no ports, no
 * HTTP client, no teardown races.
 */
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import type { Database } from './db/index.js';
import { ApiError, internalError } from './lib/errors.js';
import { purgeExpiredSessions } from './lib/sessions.js';
import { registerAuth } from './plugins/auth.js';
import { authRoutes } from './routes/auth.js';
import { designRoutes } from './routes/designs.js';
import { deviceRoutes } from './routes/devices.js';
import { geoRoutes } from './routes/geo.js';
import { ingestRoutes } from './routes/ingest.js';
import { readingRoutes } from './routes/readings.js';

export interface BuildOptions {
  readonly db: Database;
  readonly logger?: boolean;
}

export async function buildApp({
  db,
  logger = !config.isTest,
}: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ? { level: config.LOG_LEVEL } : false,
    trustProxy: config.TRUST_PROXY,
    // Default ceiling for every route; ingest raises its own.
    bodyLimit: 256 * 1024,
    // Requests are correlated by a server-generated id. Accepting a
    // client-supplied one would let a caller poison the logs.
    genReqId: () => Math.random().toString(36).slice(2, 12),
  });

  /**
   * CORS.
   *
   * An explicit allowlist, never a wildcard — and a wildcard would be rejected
   * by the browser anyway once credentials are involved. An unknown origin gets
   * no CORS headers, so the browser blocks the response.
   */
  await app.register(cors, {
    origin(origin, callback) {
      // Same-origin and non-browser callers (the Pico, curl) send no Origin.
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, config.ALLOWED_ORIGINS.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'authorization'],
    exposedHeaders: ['retry-after'],
    maxAge: 600,
  });

  await app.register(cookie, {});

  /**
   * Global limiter, keyed by user when there is one so that several people
   * behind one NAT do not exhaust a shared budget. Routes with their own
   * per-resource limits opt out via `config.rateLimit: false`.
   */
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.auth?.user.id ?? request.ip,
    errorResponseBuilder: () => ({
      error: { code: 'rate_limited', message: 'Too many requests. Try again shortly.' },
    }),
  });

  /** Response hardening. The API serves JSON and binary tiles, nothing renderable. */
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'geolocation=(self), camera=(), microphone=()');
    // Tiles are fetched cross-origin by the SPA, so resources must be readable
    // across origins; CORS still decides who may read them.
    reply.header('cross-origin-resource-policy', 'cross-origin');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");

    if (config.isProduction) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }

    return payload;
  });

  /**
   * The single place an error becomes a response.
   *
   * Known `ApiError`s carry a message written for a user. Everything else —
   * a SQLite constraint violation, a TypeError, a failed upstream parse —
   * collapses to a generic 500. The real cause is logged with the request id
   * and never serialised, so a stack trace or SQL fragment cannot reach the UI.
   *
   * Registered *before* the routes on purpose. `register()` creates a child
   * encapsulation context that inherits whatever error handler the parent had
   * at that moment, so setting this afterwards would leave every route on
   * Fastify's default serialiser — which happily emits its own error shape.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error.internal ?? error, code: error.code }, 'api error');
      } else {
        request.log.info({ code: error.code, path: request.url }, 'request rejected');
      }
      reply.code(error.statusCode);
      return reply.send(error.toResponse());
    }

    if (error instanceof ZodError) {
      reply.code(422);
      return reply.send({
        error: {
          code: 'validation_failed',
          message: 'Some fields need attention.',
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.') || '(body)',
            message: issue.message,
          })),
        },
      });
    }

    // Fastify's own body-parse, payload-size, and content-type failures.
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode === 400 || statusCode === 413 || statusCode === 415) {
      request.log.info({ err: error }, 'malformed request');
      reply.code(statusCode);
      return reply.send({
        error: {
          code: statusCode === 413 ? 'payload_too_large' : 'bad_request',
          message:
            statusCode === 413
              ? 'That request was too large.'
              : 'The request could not be processed.',
        },
      });
    }

    if (statusCode === 429) {
      reply.code(429);
      return reply.send({
        error: { code: 'rate_limited', message: 'Too many requests. Try again shortly.' },
      });
    }

    request.log.error({ err: error, path: request.url }, 'unhandled error');
    const safe = internalError(error);
    reply.code(safe.statusCode);
    return reply.send(safe.toResponse());
  });

  app.setNotFoundHandler(
    { preHandler: app.rateLimit({ max: 60, timeWindow: '1 minute' }) },
    async (_request, reply) => {
      reply.code(404);
      return { error: { code: 'not_found', message: 'Not found.' } };
    },
  );

  registerAuth(app, db);

  app.get('/health', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
    time: new Date().toISOString(),
  }));

  await app.register(authRoutes);
  await app.register(deviceRoutes);
  await app.register(readingRoutes);
  await app.register(ingestRoutes);
  await app.register(designRoutes);
  await app.register(geoRoutes);

  // Housekeeping: drop expired session rows hourly. Unref'd so it never holds
  // the process open during a shutdown or a test run.
  const purgeTimer = setInterval(() => {
    try {
      purgeExpiredSessions(db);
    } catch (cause) {
      app.log.warn({ err: cause }, 'session purge failed');
    }
  }, 3_600_000);
  purgeTimer.unref();

  app.addHook('onClose', async () => {
    clearInterval(purgeTimer);
  });

  return app;
}
