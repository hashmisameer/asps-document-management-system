import { describe, expect, it } from 'vitest'
import {
  API_ERROR_CODES,
  DOCUMENT_FIELDS,
  FIELD_CHECK_RESULTS,
  TEXT_SOURCES,
} from '@asps-dms/shared'
import { ApiError } from '../../src/lib/apiError.js'
import {
  identityFailureOf,
  unconfirmedLabels,
} from '../../src/features/documents/identityFailure.js'

/**
 * Reading a refused upload's per-field detail.
 *
 * What is pinned here is the behaviour that decides whether someone can carry
 * on: a refusal must always open the override, even when its payload arrives in
 * a shape this screen did not expect.
 */

function refusal(details: unknown): ApiError {
  return new ApiError({
    code: API_ERROR_CODES.IDENTITY_CHECK_FAILED,
    message: 'This document does not mention the employee.',
    status: 422,
    details,
  })
}

describe('identityFailureOf', () => {
  it('reads the per-field outcome off a refused upload', () => {
    const failure = identityFailureOf(
      refusal({
        source: TEXT_SOURCES.PDF_TEXT,
        unreadable: false,
        checks: [
          {
            field: DOCUMENT_FIELDS.EMPLOYEE_NAME,
            result: FIELD_CHECK_RESULTS.MATCHED,
            expected: 'Ravi Kumar',
          },
          {
            field: DOCUMENT_FIELDS.AADHAAR_NUMBER,
            result: FIELD_CHECK_RESULTS.NOT_FOUND,
            expected: null,
          },
        ],
      }),
    )

    expect(failure).not.toBeNull()
    expect(failure?.unreadable).toBe(false)
    expect(failure?.checks).toHaveLength(2)
  })

  it('reports a file nothing could be read from', () => {
    const failure = identityFailureOf(refusal({ unreadable: true, checks: [] }))
    expect(failure?.unreadable).toBe(true)
  })

  it('is not a refusal when the error is any other code', () => {
    const other = new ApiError({
      code: API_ERROR_CODES.VALIDATION_FAILED,
      message: 'Not valid.',
      status: 400,
    })
    expect(identityFailureOf(other)).toBeNull()
    expect(identityFailureOf(new Error('network'))).toBeNull()
  })

  it('still offers the override when the detail is missing or malformed', () => {
    // The person must not be left at a dead end by a payload this screen did
    // not expect: they lose the field list, never the way forward.
    expect(identityFailureOf(refusal(undefined))).toEqual({ unreadable: false, checks: [] })
    expect(identityFailureOf(refusal('nonsense'))).toEqual({ unreadable: false, checks: [] })
    expect(identityFailureOf(refusal({ checks: 'not-an-array' }))?.checks).toEqual([])
    expect(identityFailureOf(refusal({ checks: [{ field: 'NoSuchField' }] }))?.checks).toEqual([])
  })
})

describe('unconfirmedLabels', () => {
  it('names only the details that were not found, by label', () => {
    const labels = unconfirmedLabels({
      unreadable: false,
      checks: [
        {
          field: DOCUMENT_FIELDS.EMPLOYEE_NAME,
          result: FIELD_CHECK_RESULTS.MATCHED,
          expected: 'Ravi Kumar',
        },
        {
          field: DOCUMENT_FIELDS.PAN_NUMBER,
          result: FIELD_CHECK_RESULTS.NOT_FOUND,
          expected: null,
        },
        {
          field: DOCUMENT_FIELDS.UAN_NUMBER,
          result: FIELD_CHECK_RESULTS.MISSING_ON_RECORD,
          expected: null,
        },
      ],
    })

    // The matched field and the one the office never recorded are both left
    // out: neither is something to go and look at the page for.
    expect(labels).toHaveLength(1)
    expect(labels[0]?.toLowerCase()).toContain('pan')
  })
})
