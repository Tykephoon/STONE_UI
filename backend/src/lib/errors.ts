/**
 * The error contract.
 *
 * Responses carry a stable machine-readable `code` and a message written for a
 * user. Anything that could describe internals — stack traces, SQL text, file
 * paths, upstream provider responses, internal IDs — is logged server-side and
 * never serialised into the response body. Unrecognised throwables become a
 * generic 500, so a new failure mode fails closed by default.
 */

export type ErrorCode =
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
  | 'internal_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  invalid_credentials: 401,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  registration_closed: 403,
  upstream_unavailable: 502,
  internal_error: 500,
};

export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly issues?: FieldIssue[];
  /** Detail for the server log only. Never serialised to the client. */
  readonly internal?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options: { issues?: FieldIssue[]; internal?: unknown } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.issues = options.issues;
    this.internal = options.internal;
  }

  toResponse(): { error: { code: ErrorCode; message: string; issues?: FieldIssue[] } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.issues?.length ? { issues: this.issues } : {}),
      },
    };
  }
}

export const badRequest = (message = 'The request could not be processed.', issues?: FieldIssue[]) =>
  new ApiError('bad_request', message, { issues });

export const validationFailed = (issues: FieldIssue[], message = 'Some fields need attention.') =>
  new ApiError('validation_failed', message, { issues });

export const unauthenticated = (message = 'Sign in to continue.') =>
  new ApiError('unauthenticated', message);

/**
 * Deliberately identical for "no such account" and "wrong password" — the
 * distinction is exactly what account enumeration needs.
 */
export const invalidCredentials = () =>
  new ApiError('invalid_credentials', 'That email and password combination is not valid.');

export const forbidden = (message = 'You do not have access to this.') =>
  new ApiError('forbidden', message);

/**
 * Used for records that exist but belong to someone else, as well as records
 * that genuinely do not exist. Returning 403 for the former would confirm the
 * ID is real to anyone probing.
 */
export const notFound = (message = 'Not found.') => new ApiError('not_found', message);

export const conflict = (message: string) => new ApiError('conflict', message);

export const rateLimited = (message = 'Too many requests. Try again shortly.') =>
  new ApiError('rate_limited', message);

export const upstreamUnavailable = (internal?: unknown) =>
  new ApiError('upstream_unavailable', 'That service is temporarily unavailable.', { internal });

export const internalError = (internal?: unknown) =>
  new ApiError('internal_error', 'Something went wrong on our end.', { internal });
