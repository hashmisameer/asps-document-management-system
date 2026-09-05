/**
 * API error codes.
 *
 * Shared so the frontend can branch on a stable code instead of matching on
 * message text. The message is for humans and may be reworded at any time; the
 * code is the contract.
 *
 * Every error response uses the same envelope (`ApiErrorBody` in
 * types/domain.ts). Stack traces and driver messages never cross that boundary.
 */

export const API_ERROR_CODES = {
  /** Input failed schema validation. `details` carries the field issues. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** The request body was not parseable JSON. */
  INVALID_JSON: 'INVALID_JSON',
  /** Well-formed but unacceptable for a reason other than validation. */
  BAD_REQUEST: 'BAD_REQUEST',

  /** No session, or the session is no longer valid. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** The session existed but has expired or been revoked. */
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  /** Authenticated, but the account must set a new password before continuing. */
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  /** Authenticated, but the role lacks the required permission. */
  FORBIDDEN: 'FORBIDDEN',

  NOT_FOUND: 'NOT_FOUND',
  /** A uniqueness or concurrency conflict. */
  CONFLICT: 'CONFLICT',
  /** A status change the state machine does not allow (see documents.ts). */
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',

  /**
   * An uploaded document did not confirm the employee it was filed against.
   * `details` carries the per-field outcome, so the screen can say which detail
   * could not be found rather than only that something was wrong.
   */
  IDENTITY_CHECK_FAILED: 'IDENTITY_CHECK_FAILED',

  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  RATE_LIMITED: 'RATE_LIMITED',

  /** Something failed server-side. `referenceId` correlates it with the log. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** A dependency (the database, the storage volume) is unreachable. */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES]

/**
 * Default user-facing message per code.
 *
 * Wording is deliberately non-specific for the authentication codes: telling a
 * caller whether the username or the password was wrong helps an attacker
 * enumerate accounts.
 */
export const API_ERROR_MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  [API_ERROR_CODES.VALIDATION_FAILED]: 'Some of the information provided is not valid.',
  [API_ERROR_CODES.INVALID_JSON]: 'The request body could not be read as JSON.',
  [API_ERROR_CODES.BAD_REQUEST]: 'The request could not be processed.',
  [API_ERROR_CODES.UNAUTHENTICATED]: 'Please sign in to continue.',
  [API_ERROR_CODES.SESSION_EXPIRED]: 'Your session has ended. Please sign in again.',
  [API_ERROR_CODES.PASSWORD_CHANGE_REQUIRED]: 'You must set a new password before continuing.',
  [API_ERROR_CODES.FORBIDDEN]: 'You do not have permission to do that.',
  [API_ERROR_CODES.NOT_FOUND]: 'The requested item was not found.',
  [API_ERROR_CODES.CONFLICT]: 'That change conflicts with the current state of the record.',
  [API_ERROR_CODES.INVALID_STATE_TRANSITION]: 'That change is not allowed from the current status.',
  [API_ERROR_CODES.IDENTITY_CHECK_FAILED]:
    'This document does not appear to belong to this employee.',
  [API_ERROR_CODES.PAYLOAD_TOO_LARGE]: 'The file or request is too large.',
  [API_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE]: 'That file type is not accepted.',
  [API_ERROR_CODES.RATE_LIMITED]: 'Too many attempts. Please wait and try again.',
  [API_ERROR_CODES.INTERNAL_ERROR]: 'Something went wrong. Please try again.',
  [API_ERROR_CODES.SERVICE_UNAVAILABLE]: 'The service is temporarily unavailable.',
}

/** One field-level problem, as returned in `details` for VALIDATION_FAILED. */
export interface ApiValidationIssue {
  /** Dotted path to the offending field, e.g. 'joiningDate' or 'items.0.x'. */
  path: string
  message: string
}
