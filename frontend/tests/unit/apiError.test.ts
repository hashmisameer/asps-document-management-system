import { describe, expect, it } from 'vitest'
import { API_ERROR_CODES } from '@asps-dms/shared'
import { ApiError, toApiError } from '../../src/lib/apiError.js'

/**
 * Everything the UI shows on a failure comes from here, so these are the
 * assertions that stop a raw axios message reaching a user.
 */
describe('toApiError', () => {
  it('keeps the code, message and field issues from the API envelope', () => {
    const error = toApiError({
      response: {
        status: 400,
        data: {
          error: {
            code: API_ERROR_CODES.VALIDATION_FAILED,
            message: 'Some of the information is not valid.',
            details: { issues: [{ path: 'currentPassword', message: 'Current password is incorrect.' }] },
          },
        },
      },
    })

    expect(error.code).toBe(API_ERROR_CODES.VALIDATION_FAILED)
    expect(error.status).toBe(400)
    expect(error.issueFor('currentPassword')).toBe('Current password is incorrect.')
    expect(error.issueFor('newPassword')).toBeUndefined()
  })

  it('carries the reference id through, so the user can quote it', () => {
    const error = toApiError({
      response: {
        status: 500,
        data: {
          error: {
            code: API_ERROR_CODES.INTERNAL_ERROR,
            message: 'Something went wrong.',
            referenceId: '2b0f-45',
          },
        },
      },
    })

    expect(error.referenceId).toBe('2b0f-45')
  })

  it('recognises both ways a session ends', () => {
    const noSession = toApiError({
      response: {
        status: 401,
        data: { error: { code: API_ERROR_CODES.UNAUTHENTICATED, message: 'Please sign in.' } },
      },
    })
    const expired = toApiError({
      response: {
        status: 401,
        data: { error: { code: API_ERROR_CODES.SESSION_EXPIRED, message: 'Session ended.' } },
      },
    })
    const forbidden = toApiError({
      response: {
        status: 403,
        data: { error: { code: API_ERROR_CODES.FORBIDDEN, message: 'Not allowed.' } },
      },
    })

    expect(noSession.isAuthentication).toBe(true)
    expect(expired.isAuthentication).toBe(true)
    // A 403 is a permission problem, not a session problem: signing out over it
    // would be both wrong and infuriating.
    expect(forbidden.isAuthentication).toBe(false)
  })

  it('explains a request that never reached the server', () => {
    const offline = toApiError({ message: 'Network Error' })

    expect(offline.status).toBe(0)
    expect(offline.code).toBe(API_ERROR_CODES.SERVICE_UNAVAILABLE)
    expect(offline.message).toMatch(/network/i)
  })

  it('distinguishes a timeout from an unreachable server', () => {
    const timedOut = toApiError({ code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' })

    expect(timedOut.message).toMatch(/too long/i)
    // The axios wording never reaches the user.
    expect(timedOut.message).not.toContain('30000ms')
  })

  it('does not leak a response this API did not produce', () => {
    const proxyPage = toApiError({
      response: { status: 502, data: '<html><body>Bad Gateway - nginx/1.24.0</body></html>' },
    })

    // A gateway failure, not an application fault: nothing in this application
    // ran. Reported as SERVICE_UNAVAILABLE so the message can say what actually
    // happened rather than blaming the request.
    expect(proxyPage.code).toBe(API_ERROR_CODES.SERVICE_UNAVAILABLE)
    expect(proxyPage.message).not.toContain('nginx')
  })

  it('reads an empty 500 as the connection breaking, not as a bad document', () => {
    // Reproduced by restarting the API during a 60-second upload: the proxy
    // answers 500 with no body at all. This API answers every failure with an
    // envelope, 500s included, so a 5xx without one never came from it.
    //
    // It used to reach the person uploading as 'Something went wrong. Please
    // try again.', which sent them looking at their document for a fault that
    // was never in it.
    const dropped = toApiError({ response: { status: 500, data: '' } })

    expect(dropped.code).toBe(API_ERROR_CODES.SERVICE_UNAVAILABLE)
    expect(dropped.message).toContain('nothing was saved')
    expect(dropped.message).toContain('not a problem with the document')
  })

  it('still reports a real application 500, which arrives with an envelope', () => {
    const real = toApiError({
      response: {
        status: 500,
        data: {
          error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', referenceId: 'abc123' },
        },
      },
    })

    expect(real.code).toBe(API_ERROR_CODES.INTERNAL_ERROR)
    expect(real.referenceId).toBe('abc123')
  })

  it('passes an ApiError through unchanged', () => {
    const original = new ApiError({ code: 'X', message: 'Y', status: 418 })

    expect(toApiError(original)).toBe(original)
  })
})
