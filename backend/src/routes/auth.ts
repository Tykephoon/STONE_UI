/**
 * Registration, login, refresh, logout, and identity.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import type { Database } from '../db/index.js';
import { fakeVerifyPassword, hashPassword, verifyPassword } from '../lib/crypto.js';
import { ApiError, conflict, invalidCredentials, rateLimited, unauthenticated } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import {
  createSession,
  revokeAllSessionsForUser,
  revokeSession,
  rotateSession,
} from '../lib/sessions.js';
import { parseOrThrow } from '../lib/validate.js';
import {
  type AuthenticatedUser,
  clearSessionCookies,
  setSessionCookies,
} from '../plugins/auth.js';

const emailSchema = z
  .string()
  .trim()
  .min(3, 'Enter an email address.')
  .max(254, 'That email address is too long.')
  .email('Enter a valid email address.');

/**
 * Length is the only hard requirement. Composition rules (a digit, a symbol)
 * push users towards predictable substitutions without meaningfully raising
 * entropy, so they are not imposed here.
 */
const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(200, 'Keep it under 200 characters.');

const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    display_name: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().trim().min(1).max(254),
    password: z.string().min(1).max(200),
  })
  .strict();

/** Failed logins allowed per account before a temporary lock. */
const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;

/**
 * Per-account throttle, in the database rather than in memory.
 *
 * The HTTP rate limiter already caps requests per IP; this catches the
 * distributed case where one account is attacked from many addresses, and it
 * survives a restart.
 */
function checkThrottle(db: Database, key: string): void {
  const row = db
    .prepare('SELECT failures, window_start, locked_until FROM auth_throttle WHERE key = ?')
    .get(key) as { failures: number; window_start: string; locked_until: string | null } | undefined;

  if (row?.locked_until && Date.parse(row.locked_until) > Date.now()) {
    throw rateLimited('Too many attempts. Try again in a few minutes.');
  }
}

function recordFailure(db: Database, key: string): void {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const row = db
    .prepare('SELECT failures, window_start FROM auth_throttle WHERE key = ?')
    .get(key) as { failures: number; window_start: string } | undefined;

  const withinWindow = row && now - Date.parse(row.window_start) < WINDOW_MS;
  const failures = withinWindow ? row.failures + 1 : 1;
  const windowStart = withinWindow ? row.window_start : nowIso;
  const lockedUntil = failures >= MAX_FAILURES ? new Date(now + LOCK_MS).toISOString() : null;

  db.prepare(
    `INSERT INTO auth_throttle (key, failures, window_start, locked_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       failures = excluded.failures,
       window_start = excluded.window_start,
       locked_until = excluded.locked_until`,
  ).run(key, failures, windowStart, lockedUntil);
}

function clearThrottle(db: Database, key: string): void {
  db.prepare('DELETE FROM auth_throttle WHERE key = ?').run(key);
}

function publicUser(user: AuthenticatedUser) {
  return {
    id: user.id,
    email: user.emailDisplay,
    display_name: user.displayName,
    created_at: user.createdAt,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const db = app.db;

  /**
   * Hands the SPA a CSRF token without requiring it to read `document.cookie`
   * for the common case, and lets a fresh tab confirm the session is alive.
   */
  app.get('/api/auth/csrf', async (request) => {
    if (!request.auth) {
      return { csrf_token: null, authenticated: false };
    }
    return { csrf_token: request.auth.session.csrf_token, authenticated: true };
  });

  app.get('/api/auth/me', async (request) => {
    app.requireUser(request);
    return {
      user: publicUser(request.auth.user),
      session: {
        expires_at: request.auth.session.expires_at,
        absolute_expires_at: request.auth.session.absolute_expires_at,
      },
    };
  });

  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      if (!config.REGISTRATION_ENABLED) {
        throw new ApiError('registration_closed', 'Registration is closed.');
      }

      const body = parseOrThrow(registerSchema, request.body);
      const email = body.email.toLowerCase();

      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existing) {
        // Registration inherently reveals whether an address is taken — there
        // is no way to create an account at an address that already exists.
        // The mitigation is the rate limit above, not a vague message.
        throw conflict('An account with that email already exists.');
      }

      const now = new Date().toISOString();
      const id = newId('usr');
      const passwordHash = await hashPassword(body.password);

      db.prepare(
        `INSERT INTO users (id, email, email_display, password_hash, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, email, body.email, passwordHash, body.display_name ?? null, now, now);

      const issued = createSession(db, id, request.headers['user-agent'] ?? null);
      setSessionCookies(reply, issued);

      reply.code(201);
      return {
        user: {
          id,
          email: body.email,
          display_name: body.display_name ?? null,
          created_at: now,
        },
        csrf_token: issued.csrfToken,
      };
    },
  );

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const body = parseOrThrow(loginSchema, request.body);
      const email = body.email.toLowerCase();
      const throttleKey = `login:${email}`;

      checkThrottle(db, throttleKey);

      const user = db
        .prepare('SELECT id, email_display, password_hash, display_name, created_at FROM users WHERE email = ?')
        .get(email) as
        | {
            id: string;
            email_display: string;
            password_hash: string;
            display_name: string | null;
            created_at: string;
          }
        | undefined;

      if (!user) {
        // Spend the same CPU as a real verification so timing does not reveal
        // whether the account exists, then fail with the identical error.
        await fakeVerifyPassword(body.password);
        recordFailure(db, throttleKey);
        throw invalidCredentials();
      }

      const ok = await verifyPassword(user.password_hash, body.password);
      if (!ok) {
        recordFailure(db, throttleKey);
        throw invalidCredentials();
      }

      clearThrottle(db, throttleKey);

      const issued = createSession(db, user.id, request.headers['user-agent'] ?? null);
      setSessionCookies(reply, issued);

      return {
        user: {
          id: user.id,
          email: user.email_display,
          display_name: user.display_name,
          created_at: user.created_at,
        },
        csrf_token: issued.csrfToken,
      };
    },
  );

  /**
   * Slide the session window and rotate the token. The SPA calls this on a
   * timer well inside the TTL, and once on a 401 before giving up.
   */
  app.post('/api/auth/refresh', async (request, reply) => {
    if (!request.auth) {
      clearSessionCookies(reply);
      throw unauthenticated('Your session has expired. Sign in again.');
    }

    const issued = rotateSession(db, request.auth.session);
    if (!issued) {
      // Absolute cap reached: a genuine re-authentication is required.
      clearSessionCookies(reply);
      throw unauthenticated('Your session has expired. Sign in again.');
    }

    setSessionCookies(reply, issued);
    return {
      user: publicUser(request.auth.user),
      csrf_token: issued.csrfToken,
      expires_at: issued.expiresAt.toISOString(),
    };
  });

  /**
   * Logout deletes the session row. Clearing the cookie is a courtesy to the
   * browser; the invalidation is the database delete.
   */
  app.post('/api/auth/logout', async (request, reply) => {
    if (request.auth) {
      revokeSession(db, request.auth.session.id);
    }
    clearSessionCookies(reply);
    reply.code(204);
    return null;
  });

  /** Sign out everywhere — the correct response to a suspected token leak. */
  app.post('/api/auth/logout-all', async (request, reply) => {
    app.requireUser(request);
    const count = revokeAllSessionsForUser(db, request.auth.user.id);
    clearSessionCookies(reply);
    return { revoked: count };
  });
}
