import type { AuthUser, ChangePasswordInput, LoginInput } from '@asps-dms/shared'
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
