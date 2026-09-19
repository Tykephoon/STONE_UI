/**
 * The error contract.
 *
 * Responses carry a stable machine-readable `code` and a message written for a
 * user. Anything that could describe internals — stack traces, SQL text, file
 * paths, upstream provider responses — is logged server-side and never
 * serialised into the response body. Unrecognised throwables become a generic
 * 500, so a new failure mode fails closed by default.
 */

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  /** Only ever raised by `/api/ingest` for a missing or unknown device key. */
  | 'unauthenticated'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'upstream_unavailable'
  | 'internal_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
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

export const validationFailed = (issues: FieldIssue[], message = 'Some fields need attention.') =>
  new ApiError('validation_failed', message, { issues });

/**
 * A device key was missing or unrecognised.
 *
 * The same message is used for both, so probing cannot distinguish a malformed
 * key from a real one that has been rotated out.
 */
export const unauthenticated = (message = 'A valid device key is required.') =>
  new ApiError('unauthenticated', message);

/** Used for records that do not exist, and for routes that are not registered. */
export const notFound = (message = 'Not found.') => new ApiError('not_found', message);

export const conflict = (message: string) => new ApiError('conflict', message);

export const rateLimited = (message = 'Too many requests. Try again shortly.') =>
  new ApiError('rate_limited', message);

export const upstreamUnavailable = (internal?: unknown) =>
  new ApiError('upstream_unavailable', 'That service is temporarily unavailable.', { internal });

export const internalError = (internal?: unknown) =>
  new ApiError('internal_error', 'Something went wrong on our end.', { internal });
