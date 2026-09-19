/**
 * The HTTP layer.
 *
 * Every network call in the application goes through `request()`. UI components
 * never call `fetch` directly, so endpoint construction and error normalisation
 * each have exactly one implementation.
 *
 * This installation has no user accounts, so there is no session cookie, no
 * CSRF token, and no credential of any kind in this file. `credentials` is left
 * at the default (`same-origin`), which means the browser sends nothing
 * cross-origin to the API — there is nothing to send.
 *
 * The one credential the system still has is the device key, and it lives on
 * the device. It never appears in this bundle.
 */
import { config } from '../config';

export type ApiErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'payload_too_large'
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
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
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
  const { method = 'GET', body, query, signal, raw = false } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
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

  if (!response.ok) {
    throw await parseError(response);
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
 * Trigger a browser download from the API.
 *
 * A plain `<a href>` would work here now that no credential is involved, but
 * routing through `request()` keeps error handling identical to every other
 * call and lets the server's filename win.
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
