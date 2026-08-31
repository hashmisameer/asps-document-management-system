import { useContext } from 'react'
import { AuthContext, type AuthContextValue } from './authContext.js'

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) {
    // A component rendered outside AuthProvider would otherwise silently see
    // "signed out" and redirect to the login page, which is a confusing way to
    // report a missing provider.
    throw new Error('useAuth must be used inside <AuthProvider>')
  }
  return context
}
