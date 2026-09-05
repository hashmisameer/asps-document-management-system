import type { AuthUser, ChangePasswordInput, LoginInput, RegisterInput } from '@asps-dms/shared'
import { api } from '../../lib/api.js'
import { ApiError } from '../../lib/apiError.js'

/** The auth endpoints. The session token is never seen here: it is in the cookie. */

interface SessionResponse {
  user: AuthUser
  expiresAt: string
}

/**
 * The current user, or null when there is no session.
 *
 * Null rather than a thrown error: "nobody is signed in" is the ordinary state
 * on first load, not a failure, and treating it as one would put an error
 * screen in front of the login form.
 */
export async function fetchCurrentUser(): Promise<AuthUser | null> {
  try {
    const response = await api.get<{ user: AuthUser }>('/auth/me')
    return response.data.user
  } catch (error) {
    if (error instanceof ApiError && error.isAuthentication) return null
    throw error
  }
}

export async function login(input: LoginInput): Promise<AuthUser> {
  const response = await api.post<SessionResponse>('/auth/login', input)
  return response.data.user
}

export async function logout(): Promise<void> {
  try {
    await api.post('/auth/logout')
  } catch (error) {
    // The session was already gone server-side. The user asked to sign out and
    // is signing out; failing here would only strand them on a dead session.
    if (error instanceof ApiError && error.isAuthentication) return
    throw error
  }
}

export async function changePassword(input: ChangePasswordInput): Promise<AuthUser> {
  const response = await api.post<SessionResponse>('/auth/change-password', input)
  return response.data.user
}

export const AUTH_QUERY_KEY = ['auth', 'me'] as const

export interface RegistrationStatus {
  open: boolean
  remaining: number
  secretRequired: boolean
  firstAccount: boolean
}

/**
 * Whether the registration form is still open.
 *
 * Public, and asked before the sign-in page offers the link: a form that cannot
 * succeed should not be advertised. This is a convenience, not the control -
 * the cap is counted in the database on every attempt.
 */
export async function fetchRegistrationStatus(): Promise<RegistrationStatus> {
  const response = await api.get<{ registration: RegistrationStatus }>('/auth/registration')
  return response.data.registration
}

export async function register(
  input: RegisterInput,
): Promise<{ username: string; role: string }> {
  const response = await api.post<{ registered: { username: string; role: string } }>(
    '/auth/register',
    input,
  )
  return response.data.registered
}

export const REGISTRATION_QUERY_KEY = ['auth', 'registration'] as const
