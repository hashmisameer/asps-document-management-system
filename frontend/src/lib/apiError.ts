import { API_ERROR_CODES, type ApiErrorBody, type ApiValidationIssue } from '@asps-dms/shared'

/**
 * The single error type the UI deals with.
 *
 * Every failure - a rejected request, a dropped connection, a timeout - becomes
 * one of these, so a component never has to know whether it is holding an axios
 * error, a DOMException or a parsed envelope. The `code` comes from the server
 * and is stable; the `message` is written for the user and may be reworded.
 */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly issues: ApiValidationIssue[]
  /**
   * The envelope's `details`, as the server sent it.
   *
   * Untyped on purpose: what is in it depends on the code, and only the screen
   * that handles that code knows its shape. The identity check is the one that
   * uses it today - it carries the per-field outcome so the upload form can say
   * which detail could not be found.
   */
  readonly details: unknown
  /** Present on a server fault. Worth showing: it matches the server log. */
  readonly referenceId: string | null

  constructor(options: {
    code: string
    message: string
    status: number
    issues?: ApiValidationIssue[]
    details?: unknown
    referenceId?: string | null
  }) {
    super(options.message)
    this.name = 'ApiError'
    this.code = options.code
    this.status = options.status
    this.issues = options.issues ?? []
    this.details = options.details
    this.referenceId = options.referenceId ?? null
  }

  get isAuthentication(): boolean {
    return (
      this.code === API_ERROR_CODES.UNAUTHENTICATED || this.code === API_ERROR_CODES.SESSION_EXPIRED
    )
  }

  /** The message for a named field, if the server rejected that field. */
  issueFor(path: string): string | undefined {
    return this.issues.find((issue) => issue.path === path)?.message
  }
}

interface AxiosLikeError {
  response?: { status?: number; data?: unknown }
  code?: string
  message?: string
}

function isEnvelope(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false
  const error = (value as { error: unknown }).error
  return typeof error === 'object' && error !== null && 'code' in error && 'message' in error
}

/**
 * Normalises anything thrown by the HTTP layer.
 *
 * A request that never reached the server is reported as a connection problem
 * rather than as a generic failure: on an internal LAN that is usually the
 * server being down or the machine being off the network, and saying so is more
 * use than "something went wrong".
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error

  const candidate = error as AxiosLikeError
  const status = candidate?.response?.status ?? 0
  const data = candidate?.response?.data

  if (isEnvelope(data)) {
    const issues = (data.error.details as { issues?: ApiValidationIssue[] } | undefined)?.issues
    return new ApiError({
      code: data.error.code,
      message: data.error.message,
      status,
      issues: Array.isArray(issues) ? issues : [],
      details: data.error.details,
      referenceId: data.error.referenceId ?? null,
    })
  }

  if (status === 0) {
    const timedOut = candidate?.code === 'ECONNABORTED' || candidate?.code === 'ETIMEDOUT'
    return new ApiError({
      code: API_ERROR_CODES.SERVICE_UNAVAILABLE,
      status: 0,
      message: timedOut
        ? 'The server took too long to respond. Please try again.'
        : 'Cannot reach the server. Check that you are on the office network.',
    })
  }

  // A response the API did not produce - a proxy error page, say.
  //
  // 'Something went wrong. Please try again.' was all this said, which tells
  // whoever is holding the document nothing about what to do with it. The
  // status is the one piece of evidence available here, and the three cases
  // below are the ones that actually happen, each needing a different action.
  // This API answers EVERY failure with an envelope, 500s included - the error
  // handler builds one with a reference id. So a 5xx that arrives without one
  // did not come from the application: it came from whatever sits in front of
  // it, reporting that the connection to the server broke. In development that
  // is the dev server being restarted under an upload in progress; in the office
  // it is the service being restarted, or the network dropping mid-request.
  //
  // Reproduced deliberately: restarting the API during a 60-second upload
  // returns exactly this - HTTP 500, no body - and it used to reach the person
  // uploading as 'Something went wrong. Please try again.', which sent them
  // looking at their document for a fault that was never in it.
  const gatewayFailure = status === 502 || status === 503 || status === 504 || status >= 500
  const tooLarge = status === 413

  return new ApiError({
    code: gatewayFailure ? API_ERROR_CODES.SERVICE_UNAVAILABLE : API_ERROR_CODES.INTERNAL_ERROR,
    status,
    message: gatewayFailure
      ? 'The connection to the server broke before it finished answering, so nothing was ' +
        'saved. This is not a problem with the document. Reading a scan can take a minute, ' +
        'and the server being restarted during that will do it - wait a moment and upload again.'
      : tooLarge
        ? 'That file was rejected before it reached the system for being too large. Try a ' +
          'smaller scan.'
        : `Something went wrong and the server's reply could not be read (HTTP ${status}). ` +
          'Try the upload again; if it keeps happening, report this code to whoever looks ' +
          'after the system.',
  })
}
