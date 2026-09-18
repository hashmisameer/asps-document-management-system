import { createContext } from 'react'
import type { SessionUser, ChangePasswordInput, LoginInput, Permission } from '@asps-dms/shared'

export interface AuthContextValue {
  /** Null means signed out. Undefined never escapes: see `isLoading`. */
  user: SessionUser | null
  /** True until the first /auth/me answers, so nothing flashes the login form. */
  isLoading: boolean
  signIn: (input: LoginInput) => Promise<SessionUser>
  signOut: () => Promise<void>
  changePassword: (input: ChangePasswordInput) => Promise<SessionUser>
  /**
   * Decides what to RENDER. It is not a security check - the server enforces
   * the same map on every request - so a stale answer here can only hide a
   * button, never expose data.
   */
  can: (permission: Permission) => boolean
}

export const AuthContext = createContext<AuthContextValue | null>(null)
