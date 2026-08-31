import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  type AuthUser,
  type ChangePasswordInput,
  type LoginInput,
} from '@asps-dms/shared'
import { env } from '../config/env.js'
import { ACCOUNT_LOCK_MINUTES, MAX_FAILED_LOGIN_ATTEMPTS } from '../config/security.js'
import * as sessionRepository from '../repositories/session.repository.js'
import * as userRepository from '../repositories/user.repository.js'
import { toAuthUser } from '../repositories/user.repository.js'
import { TooManyRequestsError, UnauthenticatedError, ValidationError } from '../utils/errors.js'
import * as audit from './audit.service.js'
import { fakeVerify, hashPassword, needsRehash, verifyPassword } from './password.service.js'
import {
  checkSessionValidity,
  computeSessionExpiry,
  generateSessionToken,
  hashSessionToken,
  nextIdleExpiry,
  shouldTouchSession,
} from './session.service.js'

/**
 * Authentication.
 *
 * Local accounts only - no Active Directory, LDAP or Entra ID (Section 84).
 *
 * The rule running through this file is that a failed login tells the caller
 * nothing it did not already know. Whether the username exists, whether the
 * account is deactivated, and whether the password was close are all answered
 * with the same message and the same status code. The distinctions that matter
 * for investigating an incident go to the audit log instead, where only HR and
 * Admin can read them.
 */

export interface RequestContext {
  ipAddress: string | null
  userAgent: string | null
}

export interface LoginResult {
  user: AuthUser
  /** Returned once, set as an httpOnly cookie, and never stored in plain form. */
  token: string
  expiresAt: Date
}

function invalidCredentials(): UnauthenticatedError {
  return new UnauthenticatedError('Username or password is incorrect.')
}

export async function login(input: LoginInput, context: RequestContext): Promise<LoginResult> {
  const now = new Date()
  const record = await userRepository.findByUsername(input.username)

  if (!record) {
    // Same work as a real verification, so the response time does not reveal
    // that the username is unknown.
    await fakeVerify(input.password)
    await audit.record({
      userId: null,
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entityType: AUDIT_ENTITY_TYPES.USER,
      ipAddress: context.ipAddress,
      metadata: { username: input.username, reason: 'unknown-username' },
    })
    throw invalidCredentials()
  }

  const passwordMatches = await verifyPassword(input.password, record.password)

  if (!passwordMatches) {
    await userRepository.recordFailedLogin(
      record.userId,
      MAX_FAILED_LOGIN_ATTEMPTS,
      ACCOUNT_LOCK_MINUTES,
    )
    await audit.record({
      userId: record.userId,
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entityType: AUDIT_ENTITY_TYPES.USER,
      entityId: record.userId,
      ipAddress: context.ipAddress,
      metadata: {
        username: record.username,
        reason: 'wrong-password',
        failedAttempts: record.failedLoginCount + 1,
      },
    })
    throw invalidCredentials()
  }

  // Everything below runs only for a correct password, so saying more here
  // tells an attacker who does not have it nothing at all.

  if (!record.isActive) {
    await audit.record({
      userId: record.userId,
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entityType: AUDIT_ENTITY_TYPES.USER,
      entityId: record.userId,
      ipAddress: context.ipAddress,
      metadata: { username: record.username, reason: 'account-deactivated' },
    })
    throw new UnauthenticatedError(
      'This account has been deactivated. Contact your administrator.',
    )
  }

  if (record.lockedUntil && record.lockedUntil > now) {
    const minutesLeft = Math.max(
      1,
      Math.ceil((record.lockedUntil.getTime() - now.getTime()) / 60_000),
    )
    await audit.record({
      userId: record.userId,
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entityType: AUDIT_ENTITY_TYPES.USER,
      entityId: record.userId,
      ipAddress: context.ipAddress,
      metadata: { username: record.username, reason: 'account-locked' },
    })
    // The password was right, so this is the legitimate owner arriving after
    // someone else exhausted the attempts. Telling them how long to wait is
    // more useful than a generic refusal, and reveals nothing they cannot see.
    throw new TooManyRequestsError(
      `This account is temporarily locked after too many failed attempts. ` +
        `Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`,
    )
  }

  await userRepository.recordSuccessfulLogin(record.userId)

  // A successful login is the only moment the plain password is available, so
  // it is the only moment a hash stored at an older cost can be upgraded.
  if (needsRehash(record.password.algorithm)) {
    const upgraded = await hashPassword(input.password)
    await userRepository.updatePassword(record.userId, upgraded, record.mustChangePassword)
  }

  const token = generateSessionToken()
  const { expiresAt, absoluteExpiry } = computeSessionExpiry(
    now,
    env.SESSION_IDLE_TTL_MINUTES,
    env.SESSION_ABSOLUTE_TTL_HOURS,
  )

  const sessionId = await sessionRepository.create({
    userId: record.userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    absoluteExpiry,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  })

  await audit.record({
    userId: record.userId,
    action: AUDIT_ACTIONS.LOGIN_SUCCESS,
    entityType: AUDIT_ENTITY_TYPES.USER,
    entityId: record.userId,
    ipAddress: context.ipAddress,
    metadata: { username: record.username, sessionId },
  })

  return { user: toAuthUser(record), token, expiresAt }
}

export interface AuthenticatedSession {
  user: AuthUser
  sessionId: number
}

/**
 * Resolves a cookie token to a user, or null.
 *
 * Null covers every reason a token might not be usable - unknown, revoked,
 * expired, or belonging to an account that has since been deactivated - because
 * the caller does the same thing in all four cases. The reason is logged, not
 * returned.
 */
export async function resolveSession(token: string): Promise<AuthenticatedSession | null> {
  const now = new Date()
  const session = await sessionRepository.findByTokenHash(hashSessionToken(token))
  if (!session) return null

  if (!checkSessionValidity(session, now).valid) return null

  if (!session.isActive) {
    // Deactivating a user must not wait for their session to expire.
    await sessionRepository.revoke(session.sessionId)
    return null
  }

  if (shouldTouchSession(session.lastSeenAt, now)) {
    await sessionRepository.touch(
      session.sessionId,
      nextIdleExpiry(now, env.SESSION_IDLE_TTL_MINUTES, session.absoluteExpiry),
    )
  }

  return {
    sessionId: session.sessionId,
    user: {
      userId: session.userId,
      username: session.username,
      fullName: session.fullName,
      role: session.role,
      mustChangePassword: session.mustChangePassword,
    },
  }
}

export async function logout(
  sessionId: number,
  userId: number,
  context: RequestContext,
): Promise<void> {
  await sessionRepository.revoke(sessionId)
  await audit.record({
    userId,
    action: AUDIT_ACTIONS.LOGOUT,
    entityType: AUDIT_ENTITY_TYPES.USER,
    entityId: userId,
    ipAddress: context.ipAddress,
    metadata: { sessionId },
  })
}

/**
 * Changes the caller's own password.
 *
 * Every other session for the account is revoked and a fresh one is issued for
 * the device doing the change. If the reason for the change is that someone
 * else knew the password, they are signed out the moment it completes, and the
 * person who changed it does not have to log in again to get that.
 */
export async function changePassword(
  user: AuthUser,
  input: ChangePasswordInput,
  context: RequestContext,
): Promise<LoginResult> {
  const record = await userRepository.findById(user.userId)
  if (!record) throw new UnauthenticatedError()

  const currentMatches = await verifyPassword(input.currentPassword, record.password)
  if (!currentMatches) {
    // A field-level error, so the form can point at the right box. The new
    // password is not revealed to be acceptable or otherwise either way.
    throw new ValidationError(
      [{ path: 'currentPassword', message: 'Current password is incorrect.' }],
      'Your current password is incorrect.',
    )
  }

  const hashed = await hashPassword(input.newPassword)
  await userRepository.updatePassword(record.userId, hashed, false)
  const revokedCount = await sessionRepository.revokeAllForUser(record.userId)

  const now = new Date()
  const token = generateSessionToken()
  const { expiresAt, absoluteExpiry } = computeSessionExpiry(
    now,
    env.SESSION_IDLE_TTL_MINUTES,
    env.SESSION_ABSOLUTE_TTL_HOURS,
  )
  const sessionId = await sessionRepository.create({
    userId: record.userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    absoluteExpiry,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  })

  await audit.record({
    userId: record.userId,
    action: AUDIT_ACTIONS.PASSWORD_CHANGED,
    entityType: AUDIT_ENTITY_TYPES.USER,
    entityId: record.userId,
    ipAddress: context.ipAddress,
    metadata: { username: record.username, revokedSessions: revokedCount, sessionId },
  })

  return {
    user: { ...toAuthUser(record), mustChangePassword: false },
    token,
    expiresAt,
  }
}
