import type { RequestHandler } from 'express'
import { API_ERROR_CODES, type Permission, roleHasPermission } from '@asps-dms/shared'
import { resolveSession } from '../services/auth.service.js'
import { AppError, ForbiddenError, UnauthenticatedError } from '../utils/errors.js'
import { clearSessionCookie, readSessionCookie } from '../utils/cookies.js'

/**
 * The server-side authorisation boundary.
 *
 * The frontend also knows the permission map, but only to decide what to
 * render. Every check that matters happens here: a hidden button is a courtesy,
 * this is the control.
 */

/** Rejects the request unless it carries a valid session cookie. */
export const requireAuth: RequestHandler = async (req, res, next) => {
  const token = readSessionCookie(req)

  if (!token) {
    next(new UnauthenticatedError())
    return
  }

  const session = await resolveSession(token)

  if (!session) {
    // The cookie exists but is no longer usable - expired, revoked, or for a
    // deactivated account. Clearing it stops the browser sending a dead token
    // on every subsequent request.
    clearSessionCookie(res)
    next(
      new UnauthenticatedError(
        'Your session has ended. Please sign in again.',
        API_ERROR_CODES.SESSION_EXPIRED,
      ),
    )
    return
  }

  req.user = session.user
  req.sessionId = session.sessionId
  next()
}

/**
 * Blocks everything except the routes needed to set a new password.
 *
 * A first login, or an administrator reset, leaves MustChangePassword = 1. The
 * account is authenticated but must not be able to do anything else until that
 * is dealt with, so this sits between requireAuth and the feature routers
 * rather than being checked route by route.
 */
export const requirePasswordChanged: RequestHandler = (req, _res, next) => {
  if (req.user?.mustChangePassword) {
    next(
      new AppError(
        403,
        API_ERROR_CODES.PASSWORD_CHANGE_REQUIRED,
        'You must set a new password before continuing.',
      ),
    )
    return
  }
  next()
}

/**
 * Requires a permission from ROLE_PERMISSIONS.
 *
 * Permission-based rather than role-based: `requirePermission(DOCUMENT_VERIFY)`
 * keeps working when a role is added or its permissions change, where
 * `if (role === 'HR')` scattered through the routes would not.
 */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    const user = req.user

    if (!user) {
      // requireAuth must run first; reaching here is a wiring mistake, and
      // failing closed is the only safe way to report it.
      next(new UnauthenticatedError())
      return
    }

    if (!roleHasPermission(user.role, permission)) {
      next(new ForbiddenError())
      return
    }

    next()
  }
}
