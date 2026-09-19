/**
 * The HTTP layer.
 *
 * Every network call in the application goes through `request()`. UI components
 * never call `fetch` directly, so cookie policy, CSRF handling, session refresh,
 * and error normalisation each have exactly one implementation.
 *
 * Session handling notes:
 *
 *   - `credentials: 'include'` sends the httpOnly session cookie. The token is
 *     never read by JavaScript and is never stored in localStorage or
 *     sessionStorage, so an injected script cannot exfiltrate it.
 *   - The CSRF token is the one value the client *must* read, because echoing
 *     it into a header is what a cross-origin page cannot do. It is held in
 *     memory and mirrored from the readable `stone_csrf` cookie.
 */
import { config } from '../config';

export type ApiErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'invalid_credentials'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'registration_closed'
  | 'upstream_unavailable'
  | 'internal_error'
  | 'network_error';

export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly issues: FieldIssue[];

  constructor(code: ApiErrorCode, message: string, status: number, issues: FieldIssue[] = []) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.issues = issues;
  }

  /** Field-keyed messages for inline form display. */
  fieldErrors(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const issue of this.issues) {
      map[issue.path] ??= issue.message;
    }
    return map;
  }

  get isAuthError(): boolean {
    return this.code === 'unauthenticated' || this.code === 'invalid_credentials';
  }
}

const CSRF_COOKIE = 'stone_csrf';
const CSRF_HEADER = 'X-CSRF-Token';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * In-memory mirror of the CSRF token.
 *
 * Kept in a module variable rather than re-parsed from `document.cookie` on
 * every call, and refreshed from the cookie whenever the server rotates it.
 */
let csrfToken: string | null = null;

function readCsrfCookie(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function getCsrfToken(): string | null {
  csrfToken ??= readCsrfCookie();
  return csrfToken;
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called after logout so a stale token is not replayed. */
export function clearCsrfToken(): void {
  csrfToken = null;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
  /** Skip the automatic refresh-and-retry. Used by the auth calls themselves. */
  skipRetry?: boolean;
  /** Return the raw Response instead of parsed JSON (used for file downloads). */
  raw?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${config.apiBaseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Coordinates concurrent refreshes.
 *
 * Several requests can 401 at once when a session lapses. Without this, each
 * would fire its own refresh and they would rotate the token out from under one
 * another — the last rotation wins and the others retry with a dead token.
 */
let refreshInFlight: Promise<boolean> | null = null;

/** Notified when the session is definitively gone, so the app can redirect. */
type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

function notifySessionExpired(): void {
  clearCsrfToken();
  for (const listener of sessionExpiredListeners) listener();
}

async function attemptRefresh(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(buildUrl('/api/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(getCsrfToken() ? { [CSRF_HEADER]: getCsrfToken()! } : {}),
        },
      });

      if (!response.ok) return false;

      const data = (await response.json()) as { csrf_token?: string };
      if (data.csrf_token) setCsrfToken(data.csrf_token);
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so callers awaiting this promise all observe
      // the same result before a new attempt can start.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();

  return refreshInFlight;
}

async function parseError(response: Response): Promise<ApiError> {
  let code: ApiErrorCode = 'internal_error';
  let message = 'Something went wrong. Please try again.';
  let issues: FieldIssue[] = [];

  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; issues?: FieldIssue[] };
    };
    if (body.error) {
      if (body.error.code) code = body.error.code as ApiErrorCode;
      if (body.error.message) message = body.error.message;
      if (Array.isArray(body.error.issues)) issues = body.error.issues;
    }
  } catch {
    // A non-JSON error body (a proxy's HTML 502 page, say) must not become the
    // message shown to the user. Fall through to the generic text above.
    if (response.status === 404) {
      code = 'not_found';
      message = 'Not found.';
    } else if (response.status === 429) {
      code = 'rate_limited';
      message = 'Too many requests. Try again shortly.';
    }
  }

  return new ApiError(code, message, response.status, issues);
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal, skipRetry = false, raw = false } = options;

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = { Accept: 'application/json' };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (MUTATING.has(method)) {
      const token = getCsrfToken();
      if (token) headers[CSRF_HEADER] = token;
    }

    return fetch(buildUrl(path, query), {
      method,
      // Sends and accepts the httpOnly session cookie cross-origin. The backend
      // must name this exact origin in its allowlist for the browser to expose
      // the response.
      credentials: 'include',
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  };

  let response: Response;
  try {
    response = await send();
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    // A CORS rejection, DNS failure, and offline state are indistinguishable
    // from here by design — the browser does not tell us which.
    throw new ApiError(
      'network_error',
      'Cannot reach the server. Check your connection and try again.',
      0,
    );
  }

  /**
   * One silent refresh-and-retry on 401.
   *
   * Bounded to a single attempt: if the retry also 401s, the session is
   * genuinely gone and looping would just hammer the endpoint.
   */
  if (response.status === 401 && !skipRetry) {
    const refreshed = await attemptRefresh();
    if (refreshed) {
      try {
        response = await send();
      } catch {
        throw new ApiError('network_error', 'Cannot reach the server.', 0);
      }
    } else {
      notifySessionExpired();
    }
  }

  // The CSRF cookie may have been rotated by any response; keep the mirror fresh.
  const rotated = readCsrfCookie();
  if (rotated && rotated !== csrfToken) csrfToken = rotated;

  if (!response.ok) {
    const error = await parseError(response);
    if (error.code === 'unauthenticated') notifySessionExpired();
    throw error;
  }

  if (raw) return response as unknown as T;
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError('internal_error', 'The server sent an unreadable response.', response.status);
  }
}

/**
 * Trigger a browser download from an authenticated endpoint.
 *
 * A plain `<a href>` cannot carry the credentialed cross-origin request, so the
 * payload is fetched and handed to an object URL instead.
 */
export async function downloadFile(
  path: string,
  query: RequestOptions['query'],
  fallbackFilename: string,
): Promise<void> {
  const response = await request<Response>(path, { query, raw: true });

  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const filename = match?.[1] ?? fallbackFilename;

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
