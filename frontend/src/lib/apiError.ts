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
  /** Present on a server fault. Worth showing: it matches the server log. */
  readonly referenceId: string | null

  constructor(options: {
    code: string
    message: string
    status: number
    issues?: ApiValidationIssue[]
    referenceId?: string | null
  }) {
    super(options.message)
    this.name = 'ApiError'
    this.code = options.code
    this.status = options.status
    this.issues = options.issues ?? []
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
  return new ApiError({
    code: API_ERROR_CODES.INTERNAL_ERROR,
    status,
    message: 'Something went wrong. Please try again.',
  })
}
