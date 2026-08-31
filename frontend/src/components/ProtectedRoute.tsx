import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { Permission } from '@asps-dms/shared'
import { useAuth } from '../features/auth/useAuth.js'

interface ProtectedRouteProps {
  children: ReactNode
  /** When set, the route also needs this permission. */
  permission?: Permission
  /** Set on the change-password route itself, or it would redirect to itself. */
  allowPasswordChangePending?: boolean
}

/**
 * The client-side gate.
 *
 * It decides what to render, never what is allowed: every route behind it calls
 * an API that checks the same thing server-side. Its job is to send someone to
 * the right screen, not to keep anyone out of data.
 */
export function ProtectedRoute({
  children,
  permission,
  allowPasswordChangePending = false,
}: ProtectedRouteProps) {
  const { user, isLoading, can } = useAuth()
  const location = useLocation()

  // Nothing is rendered until /auth/me has answered. Without this, a reload on
  // a deep link flashes the login page before the session is confirmed.
  if (isLoading) {
    return (
      <div className="p-8 text-sm text-slate-500" role="status">
        Loading...
      </div>
    )
  }

  if (!user) {
    // Remember where they were headed, so signing in lands them there rather
    // than dumping them on the dashboard.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  if (user.mustChangePassword && !allowPasswordChangePending) {
    return <Navigate to="/change-password" replace />
  }

  if (permission && !can(permission)) {
    return (
      <div className="p-8">
        <h1 className="text-lg font-semibold text-slate-900">Not available to your role</h1>
        <p className="mt-1 text-sm text-slate-600">
          You do not have permission to view this page. If you think you should, ask your
          administrator.
        </p>
      </div>
    )
  }

  return <>{children}</>
}
