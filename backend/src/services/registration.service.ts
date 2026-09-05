import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  MAX_SELF_REGISTRATIONS,
  ROLES,
  type RegisterInput,
  type Role,
} from '@asps-dms/shared'
import { env } from '../config/env.js'
import * as userRepository from '../repositories/user.repository.js'
import { ConflictError, ForbiddenError, ValidationError } from '../utils/errors.js'
import * as audit from './audit.service.js'
import { hashPassword } from './password.service.js'
import type { RequestContext } from './auth.service.js'

/**
 * Self-registration for the office's own staff.
 *
 * This is the one route that creates an account without an account, so it is
 * bounded on every side that could be pushed:
 *
 *   - A hard cap of MAX_SELF_REGISTRATIONS, enforced inside the INSERT so that
 *     two people registering at the same instant cannot both slip past it.
 *   - No ADMIN. A form anyone on the network can reach must not mint the role
 *     that manages every other account. The exception is a system with no users
 *     at all, where the first account has to be an Admin or nobody could
 *     administer it - and where there is, by definition, nothing yet to steal.
 *   - An optional shared secret, for an office that would rather not leave even
 *     a capped form open on the network.
 *
 * A registered account does NOT have to change its password: it chose one. That
 * is the difference from db:create-user, which issues a password somebody else
 * has seen.
 */

export interface RegistrationStatus {
  open: boolean
  remaining: number
  /** True when a secret must be supplied, so the form can ask for it. */
  secretRequired: boolean
  /** True when no account exists at all: the next one becomes the Admin. */
  firstAccount: boolean
}

export async function getStatus(): Promise<RegistrationStatus> {
  const used = await userRepository.countSelfRegistered()
  const remaining = Math.max(0, MAX_SELF_REGISTRATIONS - used)
  const anyUser = await userRepository.anyUserExists()

  return {
    open: remaining > 0,
    remaining,
    secretRequired: Boolean(env.REGISTRATION_SECRET),
    firstAccount: !anyUser,
  }
}

/**
 * Constant-time-ish comparison for the registration secret.
 *
 * Compares every character rather than stopping at the first difference, so the
 * time taken does not narrow down the secret one character at a time.
 */
function secretMatches(supplied: string, expected: string): boolean {
  if (supplied.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < expected.length; index += 1) {
    difference |= supplied.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return difference === 0
}

export async function register(
  input: RegisterInput,
  context: RequestContext,
): Promise<{ userId: number; username: string; role: Role }> {
  if (env.REGISTRATION_SECRET) {
    if (!input.registrationSecret || !secretMatches(input.registrationSecret, env.REGISTRATION_SECRET)) {
      throw new ValidationError(
        [{ path: 'registrationSecret', message: 'That registration code is not right.' }],
        'That registration code is not right.',
      )
    }
  }

  const status = await getStatus()
  if (!status.open) {
    throw new ForbiddenError(
      'Registration is closed. Ask an administrator to create your account.',
    )
  }

  // Checked before the insert so the message can say what is wrong. The unique
  // index on Username is what actually guarantees it.
  if (await userRepository.usernameExists(input.username)) {
    throw new ConflictError('That username is already taken.')
  }

  // The very first account on an empty system is the Admin, because there would
  // otherwise be nobody able to manage the others. Every later registration
  // takes the role it asked for, which can never be ADMIN.
  const role: Role = status.firstAccount ? ROLES.ADMIN : (input.role as Role)

  const password = await hashPassword(input.password)
  const userId = await userRepository.createSelfRegisteredUser({
    username: input.username,
    fullName: input.fullName,
    role,
    password,
    mustChangePassword: false,
    maxSelfRegistrations: MAX_SELF_REGISTRATIONS,
  })

  if (userId === null) {
    // The cap was reached between the check above and the insert - another
    // registration landed first. The database refused it, which is the point.
    throw new ForbiddenError(
      'Registration is closed. Ask an administrator to create your account.',
    )
  }

  await audit.record({
    userId,
    action: AUDIT_ACTIONS.USER_REGISTERED,
    entityType: AUDIT_ENTITY_TYPES.USER,
    entityId: userId,
    ipAddress: context.ipAddress,
    metadata: {
      username: input.username,
      role,
      firstAccount: status.firstAccount,
      // Recorded so it is visible later how many of the slots were gone by
      // the time this one was taken.
      remainingAfter: status.remaining - 1,
    },
  })

  return { userId, username: input.username, role }
}
