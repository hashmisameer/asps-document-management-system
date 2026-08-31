import type { CookieOptions, Request, Response } from 'express'
import { env } from '../config/env.js'

/**
 * The session cookie.
 *
 * httpOnly, so script on the page cannot read it - the single most valuable
 * property here, because it means an XSS bug cannot walk away with a session.
 * SameSite defaults to lax, which blocks the cross-site POST that a CSRF attack
 * needs while leaving ordinary navigation to the app working.
 *
 * COOKIE_SECURE is configurable rather than hard-coded true on purpose: an
 * internal LAN deployment is often plain HTTP, where `secure` would stop the
 * browser sending the cookie at all and the app would simply never log anyone
 * in. config/env.ts refuses the one combination that is unsafe rather than
 * merely wrong: SameSite=none without Secure.
 *
 * The cookie is not signed. It carries 256 bits of random token and nothing
 * else - no user id, no role, no expiry - so there is no client-visible claim
 * for a signature to protect. Forging one means guessing the token.
 */

function baseOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAME_SITE,
    path: '/',
  }
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(env.SESSION_COOKIE_NAME, token, { ...baseOptions(), expires: expiresAt })
}

export function clearSessionCookie(res: Response): void {
  // The options must match those the cookie was set with, or the browser keeps
  // the original and the user stays signed in on the client side.
  res.clearCookie(env.SESSION_COOKIE_NAME, baseOptions())
}

export function readSessionCookie(req: Request): string | null {
  const raw: unknown = req.cookies?.[env.SESSION_COOKIE_NAME]
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}
