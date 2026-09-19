/**
 * Server-side session store.
 *
 * The browser holds an opaque token in an httpOnly cookie; all authority lives
 * in the `sessions` row. That is what makes logout a real invalidation — the
 * row is deleted, so the token is dead even if the cookie survives in a proxy
 * cache, a browser restore, or an attacker's clipboard.
 *
 * Two clocks bound every session:
 *   - `expires_at`          sliding, extended on refresh (default 30 min)
 *   - `absolute_expires_at` fixed at creation, never extended (default 7 days)
 */
import type { Database } from 'better-sqlite3';
import { config } from '../config.js';
import { sha256 } from './crypto.js';
import { newId, newSecret } from './ids.js';

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token: string;
  created_at: string;
  expires_at: string;
  absolute_expires_at: string;
  last_used_at: string;
  user_agent: string | null;
}

export interface IssuedSession {
  readonly sessionId: string;
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

const minutes = (n: number) => n * 60_000;
const hours = (n: number) => n * 3_600_000;

export function createSession(
  db: Database,
  userId: string,
  userAgent: string | null,
): IssuedSession {
  const now = Date.now();
  const token = newSecret();
  const csrfToken = newSecret(24);
  const sessionId = newId('ses');

  const expiresAt = new Date(now + minutes(config.SESSION_TTL_MINUTES));
  const absoluteExpiresAt = new Date(now + hours(config.SESSION_ABSOLUTE_TTL_HOURS));
  const nowIso = new Date(now).toISOString();

  db.prepare(
    `INSERT INTO sessions
       (id, user_id, token_hash, csrf_token, created_at, expires_at,
        absolute_expires_at, last_used_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    userId,
    sha256(token),
    csrfToken,
    nowIso,
    expiresAt.toISOString(),
    absoluteExpiresAt.toISOString(),
    nowIso,
    userAgent ? userAgent.slice(0, 256) : null,
  );

  return { sessionId, token, csrfToken, expiresAt, absoluteExpiresAt };
}

/**
 * Resolve a raw cookie token to a live session, or null.
 *
 * Expiry is evaluated here rather than relying on the cookie's own Max-Age: a
 * client can present an expired cookie, and the server must not accept it.
 */
export function loadSession(db: Database, token: string): SessionRow | null {
  const row = db
    .prepare('SELECT * FROM sessions WHERE token_hash = ?')
    .get(sha256(token)) as SessionRow | undefined;

  if (!row) return null;

  const now = Date.now();
  if (Date.parse(row.expires_at) <= now || Date.parse(row.absolute_expires_at) <= now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return null;
  }

  return row;
}

export function touchSession(db: Database, sessionId: string): void {
  db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    sessionId,
  );
}

/**
 * Extend a session and issue a fresh token.
 *
 * Rotating on every refresh means a stolen token has a bounded useful life and
 * stops working as soon as the legitimate client refreshes. Returns null when
 * the absolute cap has been reached, which forces a real re-authentication.
 */
export function rotateSession(db: Database, session: SessionRow): IssuedSession | null {
  const now = Date.now();
  const absoluteExpiresAt = Date.parse(session.absolute_expires_at);

  if (absoluteExpiresAt <= now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    return null;
  }

  const token = newSecret();
  const csrfToken = newSecret(24);
  // Never slide past the absolute cap.
  const expiresAt = new Date(
    Math.min(now + minutes(config.SESSION_TTL_MINUTES), absoluteExpiresAt),
  );

  db.prepare(
    `UPDATE sessions
        SET token_hash = ?, csrf_token = ?, expires_at = ?, last_used_at = ?
      WHERE id = ?`,
  ).run(sha256(token), csrfToken, expiresAt.toISOString(), new Date(now).toISOString(), session.id);

  return {
    sessionId: session.id,
    token,
    csrfToken,
    expiresAt,
    absoluteExpiresAt: new Date(absoluteExpiresAt),
  };
}

export function revokeSession(db: Database, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function revokeAllSessionsForUser(db: Database, userId: string): number {
  const result = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return result.changes;
}

/** Housekeeping: drop rows past either clock. Safe to call on a timer. */
export function purgeExpiredSessions(db: Database): number {
  const nowIso = new Date().toISOString();
  const result = db
    .prepare('DELETE FROM sessions WHERE expires_at <= ? OR absolute_expires_at <= ?')
    .run(nowIso, nowIso);
  return result.changes;
}
