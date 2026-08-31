import {
  API_ERROR_CODES,
  DOCUMENT_FIELD_LABEL,
  FIELD_CHECK_RESULTS,
  type DocumentField,
  type FieldCheck,
} from '@asps-dms/shared'
import { ApiError } from '../../lib/apiError.js'

/**
 * Reading the identity check's per-field outcome off a refused upload.
 *
 * The server sends this in the error envelope's `details`, which is typed
 * `unknown` on purpose - what is in it depends on the code, and only the screen
 * handling that code knows its shape. This is that screen, so this is where the
 * shape is asserted.
 *
 * It is parsed defensively rather than cast. A refusal that arrives in an
 * unexpected shape must still leave the person a way forward: they see the
 * server's own sentence and the override, just without the field list. Throwing
 * here would turn a document that needs a human decision into a dead end.
 */

export interface IdentityFailure {
  /** True when nothing could be read from the file at all. */
  unreadable: boolean
  /** Empty when the payload could not be read - the override still stands. */
  checks: FieldCheck[]
}

function isFieldCheck(value: unknown): value is FieldCheck {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.field === 'string' &&
    candidate.field in DOCUMENT_FIELD_LABEL &&
    typeof candidate.result === 'string'
  )
}

/** The failure behind a refused upload, or null if this error is not one. */
export function identityFailureOf(error: unknown): IdentityFailure | null {
  if (!(error instanceof ApiError)) return null
  if (error.code !== API_ERROR_CODES.IDENTITY_CHECK_FAILED) return null

  const details = error.details
  if (typeof details !== 'object' || details === null) {
    return { unreadable: false, checks: [] }
  }

  const record = details as Record<string, unknown>
  const checks = Array.isArray(record.checks) ? record.checks.filter(isFieldCheck) : []

  return { unreadable: record.unreadable === true, checks }
}

/**
 * The details the document did not confirm, by label.
 *
 * Labels rather than field codes, and no expected values: a field the check
 * could not find is named so the person can look at the page for it, but an
 * identity number is never printed beside the failure. The server already
 * withholds those - `expected` comes back null for them - and this does not go
 * looking for them either.
 */
export function unconfirmedLabels(failure: IdentityFailure): string[] {
  return failure.checks
    .filter((check) => check.result === FIELD_CHECK_RESULTS.NOT_FOUND)
    .map((check) => DOCUMENT_FIELD_LABEL[check.field as DocumentField])
}
