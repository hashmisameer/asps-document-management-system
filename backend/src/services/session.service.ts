import crypto from 'node:crypto'
import { SESSION_TOKEN_BYTES, SESSION_TOUCH_INTERVAL_MS } from '../config/security.js'

/**
 * Session token mechanics.
 *
 * Sessions are server-side and revocable (Section 84): the cookie carries a
 * random token and nothing else - no user id, no role, no expiry the client
 * could edit. dbo.Sessions stores only the SHA-256 of that token, so a leak of
 * the table yields nothing usable; the token itself exists in the database
 * never, in a log never, and in the user's cookie jar only.
 *
 * The functions here are pure so the expiry rules can be tested without a
 * database and without waiting for real time to pass.
 */

/** 32 random bytes, base64url so it is cookie-safe without escaping. */
export function generateSessionToken(): string {
  return crypto.randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
}

/**
 * SHA-256, not scrypt.
 *
 * Deliberate, and the opposite of the password decision: a session token is 256
 * bits of randomness, so there is no guess space for an attacker to search and
 * nothing for a slow hash to buy. It is looked up on every authenticated
 * request, where slow would be an availability problem of our own making.
 */
export function hashSessionToken(token: string): Buffer {
  return crypto.createHash('sha256').update(token, 'utf8').digest()
}

export interface SessionExpiry {
  /** Idle expiry: extended as the user works. */
  expiresAt: Date
  /** Hard ceiling, fixed at issue time and never extended. */
  absoluteExpiry: Date
}

export function computeSessionExpiry(
  now: Date,
  idleTtlMinutes: number,
  absoluteTtlHours: number,
): SessionExpiry {
  const absoluteExpiry = new Date(now.getTime() + absoluteTtlHours * 60 * 60 * 1000)
  const idleExpiry = new Date(now.getTime() + idleTtlMinutes * 60 * 1000)

  return {
    // A short absolute TTL must win over a longer idle TTL, or the ceiling
    // would not be a ceiling.
    expiresAt: idleExpiry < absoluteExpiry ? idleExpiry : absoluteExpiry,
    absoluteExpiry,
  }
}

/** The extended idle expiry for an active session, never past its ceiling. */
export function nextIdleExpiry(
  now: Date,
  idleTtlMinutes: number,
  absoluteExpiry: Date,
): Date {
  const extended = new Date(now.getTime() + idleTtlMinutes * 60 * 1000)
  return extended < absoluteExpiry ? extended : absoluteExpiry
}

/** True once the extension is worth a write. See SESSION_TOUCH_INTERVAL_MS. */
export function shouldTouchSession(lastSeenAt: Date, now: Date): boolean {
  return now.getTime() - lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS
}

export interface SessionValidity {
  valid: boolean
  /** Why it is not valid, for the audit trail. Never shown to the caller. */
  reason?: 'revoked' | 'idle-expired' | 'absolute-expired'
}

/**
 * The rules a stored session row must satisfy, applied in Node as well as in
 * the SQL predicate. Two places, deliberately: the query keeps expired rows off
 * the wire, and this keeps a clock skew or a hand-edited row from letting a
 * dead session through.
 */
export function checkSessionValidity(
  session: { revokedAt: Date | null; expiresAt: Date; absoluteExpiry: Date },
  now: Date,
): SessionValidity {
  if (session.revokedAt !== null) return { valid: false, reason: 'revoked' }
  if (session.absoluteExpiry <= now) return { valid: false, reason: 'absolute-expired' }
  if (session.expiresAt <= now) return { valid: false, reason: 'idle-expired' }
  return { valid: true }
}
