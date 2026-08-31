import type { RequestHandler, Response } from 'express'
import { changePasswordSchema, loginSchema } from '@asps-dms/shared'
import * as authService from '../services/auth.service.js'
import { requestContext } from '../services/audit.service.js'
import { clearSessionCookie, setSessionCookie } from '../utils/cookies.js'
import { UnauthenticatedError } from '../utils/errors.js'
import { parseBody } from '../utils/validation.js'

/**
 * Authentication endpoints.
 *
 * Controllers stay thin on purpose: parse the input with the shared schema,
 * call the service, translate the result into HTTP. No business rule lives
 * here, so there is only one place - the service - where the rules can be read
 * or changed.
 */

/**
 * The session token goes into the httpOnly cookie and nowhere else - never
 * into the response body, where script on the page could read it.
 */
function respondWithSession(res: Response, result: authService.LoginResult): void {
  setSessionCookie(res, result.token, result.expiresAt)
  res.json({ user: result.user, expiresAt: result.expiresAt.toISOString() })
}

export const login: RequestHandler = async (req, res) => {
  const input = parseBody(req, loginSchema)
  const result = await authService.login(input, requestContext(req))
  respondWithSession(res, result)
}

export const logout: RequestHandler = async (req, res) => {
  const user = req.user
  const sessionId = req.sessionId

  if (user && sessionId !== undefined) {
    await authService.logout(sessionId, user.userId, requestContext(req))
  }

  // Cleared unconditionally: a logout must leave the browser without a cookie
  // even if the session was already gone server-side.
  clearSessionCookie(res)
  res.status(204).end()
}

export const me: RequestHandler = (req, res) => {
  if (!req.user) throw new UnauthenticatedError()
  res.json({ user: req.user })
}

export const changePassword: RequestHandler = async (req, res) => {
  if (!req.user) throw new UnauthenticatedError()

  const input = parseBody(req, changePasswordSchema)
  const result = await authService.changePassword(req.user, input, requestContext(req))

  // changePassword revokes every session for the account, including this one,
  // and issues a replacement - so the cookie has to be rewritten here.
  respondWithSession(res, result)
}
