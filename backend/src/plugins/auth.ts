/**
 * Authentication, cookie policy, and CSRF enforcement.
 *
 * Applied directly to the root instance rather than via `register`, so the
 * decorators are visible to every route without pulling in `fastify-plugin`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { Database } from '../db/index.js';
import { safeEqual } from '../lib/crypto.js';
import { forbidden, unauthenticated } from '../lib/errors.js';
import type { IssuedSession, SessionRow } from '../lib/sessions.js';
import { loadSession, touchSession } from '../lib/sessions.js';

export const SESSION_COOKIE = 'stone_session';
export const CSRF_COOKIE = 'stone_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly emailDisplay: string;
  readonly displayName: string | null;
  readonly createdAt: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only when a live session cookie was supplied. */
    auth: { session: SessionRow; user: AuthenticatedUser } | null;
  }
  interface FastifyInstance {
    db: Database;
    /**
     * preHandler guard. Throws `unauthenticated` when there is no live session.
     * Route handlers still scope their own queries by `user.id`; this guard
     * establishes identity, it does not authorise access to any record.
     */
    requireUser: (request: FastifyRequest) => asserts request is AuthenticatedRequest;
  }
}

export type AuthenticatedRequest = FastifyRequest & {
  auth: { session: SessionRow; user: AuthenticatedUser };
};

interface UserRow {
  id: string;
  email: string;
  email_display: string;
  display_name: string | null;
  created_at: string;
}

const baseCookieOptions = () => ({
  httpOnly: true,
  secure: config.COOKIE_SECURE,
  sameSite: config.COOKIE_SAMESITE as 'none' | 'lax' | 'strict',
  path: '/',
  ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
});

/**
 * Write both cookies for a freshly issued or rotated session.
 *
 * The session cookie is httpOnly so injected script cannot read it. The CSRF
 * cookie deliberately is not — the client must be able to echo it into a
 * header, which is precisely the property a cross-origin attacker lacks.
 */
export function setSessionCookies(reply: FastifyReply, issued: IssuedSession): void {
  reply.setCookie(SESSION_COOKIE, issued.token, {
    ...baseCookieOptions(),
    expires: issued.absoluteExpiresAt,
  });
  reply.setCookie(CSRF_COOKIE, issued.csrfToken, {
    ...baseCookieOptions(),
    httpOnly: false,
    expires: issued.absoluteExpiresAt,
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  const options = baseCookieOptions();
  reply.clearCookie(SESSION_COOKIE, options);
  reply.clearCookie(CSRF_COOKIE, { ...options, httpOnly: false });
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Routes exempt from CSRF because they carry no ambient authority: either they
 * authenticate with a bearer credential the browser will not attach
 * automatically (device ingest), or they establish the very session a CSRF
 * token would be bound to.
 */
const CSRF_EXEMPT_PATHS = new Set(['/api/ingest', '/api/auth/login', '/api/auth/register']);

export function registerAuth(app: FastifyInstance, db: Database): void {
  app.decorate('db', db);
  app.decorateRequest('auth', null);

  /**
   * Resolve the session cookie on every request.
   *
   * Runs for unauthenticated routes too — cheap, and it means handlers can read
   * `request.auth` without caring whether a guard ran first.
   */
  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;

    const session = loadSession(db, token);
    if (!session) return;

    const user = db
      .prepare(
        'SELECT id, email, email_display, display_name, created_at FROM users WHERE id = ?',
      )
      .get(session.user_id) as UserRow | undefined;

    // A session whose user is gone is a dangling row; treat it as no session.
    if (!user) return;

    request.auth = {
      session,
      user: {
        id: user.id,
        email: user.email,
        emailDisplay: user.email_display,
        displayName: user.display_name,
        createdAt: user.created_at,
      },
    };
  });

  /**
   * CSRF: synchroniser token plus an Origin check. Both must pass.
   *
   * Cookies are sent cross-site automatically because SameSite=None is required
   * for a github.io frontend talking to an API on another domain. The header
   * echo is what a cross-origin page cannot forge — it can cause the browser to
   * send the cookie, but it cannot read it to copy it into a header.
   */
  app.addHook('onRequest', async (request) => {
    if (!MUTATING_METHODS.has(request.method)) return;

    const path = request.url.split('?')[0] ?? '';
    if (CSRF_EXEMPT_PATHS.has(path)) return;

    // Unauthenticated mutating requests have no ambient authority to abuse;
    // they will be rejected by the route's own guard.
    if (!request.auth) return;

    const origin = request.headers.origin;
    if (origin && !config.ALLOWED_ORIGINS.includes(origin)) {
      throw forbidden('Request blocked.');
    }

    const headerValue = request.headers[CSRF_HEADER];
    const presented = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (!presented || !safeEqual(presented, request.auth.session.csrf_token)) {
      throw forbidden('Your session needs to be refreshed. Reload and try again.');
    }
  });

  app.decorate('requireUser', function requireUser(request: FastifyRequest): asserts request is AuthenticatedRequest {
    if (!request.auth) {
      throw unauthenticated();
    }
    touchSession(db, request.auth.session.id);
  });
}
