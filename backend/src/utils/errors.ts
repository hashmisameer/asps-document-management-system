import {
  API_ERROR_CODES,
  API_ERROR_MESSAGES,
  type ApiErrorCode,
  type ApiValidationIssue,
} from '@asps-dms/shared'

/**
 * Application errors.
 *
 * Every error a route can produce deliberately passes through this hierarchy,
 * so the error handler has one shape to render and there is exactly one place
 * that decides what a caller is allowed to see.
 *
 * `message` on an AppError is written for the user and IS returned. Anything
 * that must not reach the user - a driver message, a file path, a SQL error -
 * goes in `cause`, which is logged and never serialised.
 */
export class AppError extends Error {
  readonly statusCode: number
  readonly code: ApiErrorCode
  readonly details: unknown
  /** 5xx errors are logged at error level; 4xx are the caller's problem. */
  readonly isServerError: boolean

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message?: string,
    options?: { details?: unknown; cause?: unknown },
  ) {
    super(message ?? API_ERROR_MESSAGES[code], options?.cause ? { cause: options.cause } : undefined)
    this.name = new.target.name
    this.statusCode = statusCode
    this.code = code
    this.details = options?.details
    this.isServerError = statusCode >= 500
    Error.captureStackTrace?.(this, new.target)
  }
}

export class ValidationError extends AppError {
  constructor(issues: ApiValidationIssue[], message?: string) {
    super(400, API_ERROR_CODES.VALIDATION_FAILED, message, { details: { issues } })
  }
}

export class BadRequestError extends AppError {
  constructor(message?: string, options?: { cause?: unknown }) {
    super(400, API_ERROR_CODES.BAD_REQUEST, message, options)
  }
}

export class UnauthenticatedError extends AppError {
  constructor(
    message?: string,
    code: ApiErrorCode = API_ERROR_CODES.UNAUTHENTICATED,
    options?: { cause?: unknown },
  ) {
    super(401, code, message, options)
  }
}

export class ForbiddenError extends AppError {
  constructor(message?: string, options?: { details?: unknown }) {
    super(403, API_ERROR_CODES.FORBIDDEN, message, options)
  }
}

export class NotFoundError extends AppError {
  constructor(message?: string) {
    super(404, API_ERROR_CODES.NOT_FOUND, message)
  }
}

export class ConflictError extends AppError {
  constructor(
    message?: string,
    code: ApiErrorCode = API_ERROR_CODES.CONFLICT,
    options?: { details?: unknown; cause?: unknown },
  ) {
    super(409, code, message, options)
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message?: string) {
    super(413, API_ERROR_CODES.PAYLOAD_TOO_LARGE, message)
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message?: string, options?: { cause?: unknown }) {
    super(415, API_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, message, options)
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message?: string) {
    super(429, API_ERROR_CODES.RATE_LIMITED, message)
  }
}

export class InternalError extends AppError {
  constructor(message?: string, options?: { cause?: unknown }) {
    super(500, API_ERROR_CODES.INTERNAL_ERROR, message, options)
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message?: string, options?: { cause?: unknown }) {
    super(503, API_ERROR_CODES.SERVICE_UNAVAILABLE, message, options)
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}

/**
 * A message safe to put in a log line.
 *
 * Non-Error values are stringified rather than spread, so a thrown object
 * carrying a password field cannot be widened into the log record.
 */
export function describeError(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  return `Non-error thrown: ${Object.prototype.toString.call(value)}`
}
