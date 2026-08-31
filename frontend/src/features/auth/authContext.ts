import { createContext } from 'react'
import type { AuthUser, ChangePasswordInput, LoginInput, Permission } from '@asps-dms/shared'

export interface AuthContextValue {
  /** Null means signed out. Undefined never escapes: see `isLoading`. */
  user: AuthUser | null
  /** True until the first /auth/me answers, so nothing flashes the login form. */
  isLoading: boolean
  signIn: (input: LoginInput) => Promise<AuthUser>
  signOut: () => Promise<void>
  changePassword: (input: ChangePasswordInput) => Promise<AuthUser>
  /**
   * Decides what to RENDER. It is not a security check - the server enforces
   * the same map on every request - so a stale answer here can only hide a
   * button, never expose data.
   */
  can: (permission: Permission) => boolean
}

export const AuthContext = createContext<AuthContextValue | null>(null)
