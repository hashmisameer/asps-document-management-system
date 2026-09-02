import axios from 'axios'
import { toApiError } from './apiError.js'

/**
 * The HTTP client.
 *
 * `withCredentials` is what makes the session work: the token lives in an
 * httpOnly cookie, which script cannot read, so the browser has to be told to
 * send it. Nothing in this application ever holds a token in JavaScript.
 *
 * The base URL is a relative '/api' in both environments - same-origin in
 * production, and proxied by Vite in development (vite.config.ts) - so the
 * cookie behaves identically in both and there is no build-time host to get
 * wrong.
 */
/**
 * How long to wait for a request that READS a document.
 *
 * Uploading a scan is not a normal request. The server OCRs it before storing
 * anything, which takes 30 to 40 seconds for a photographed form - longer since
 * Hindi was added, because every page is now read twice.
 *
 * The general 30 second timeout was cutting those off while the server was
 * still working, and the server then finished and SAVED THE DOCUMENT: the
 * upload succeeded and the screen said it had failed, which invites somebody to
 * upload it again.
 *
 * Comfortably past IDENTITY_CHECK_TIMEOUT_MS (90s), so the server's own limit is
 * what gives up first and the reason reaches the person as a message rather
 * than as a dead request.
 */
export const DOCUMENT_READ_TIMEOUT_MS = 150_000

export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 30_000,
  headers: { Accept: 'application/json' },
})

type UnauthenticatedHandler = () => void

let onUnauthenticated: UnauthenticatedHandler | null = null

/**
 * Registered by AuthProvider so a session that expires mid-session is noticed
 * wherever it happens, not only on the next deliberate auth call. Set here
 * rather than imported to keep the client free of any React dependency.
 */
export function setUnauthenticatedHandler(handler: UnauthenticatedHandler | null): void {
  onUnauthenticated = handler
}

api.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    const apiError = toApiError(error)

    if (apiError.isAuthentication) onUnauthenticated?.()

    // Every rejection leaves this layer as an ApiError, so no caller has to
    // know what axios throws.
    return Promise.reject(apiError)
  },
)
