import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  ROLES,
  type AuthUser,
  type CreateUserInput,
  type Role,
  type UpdateUserInput,
  type UserListItem,
} from '@asps-dms/shared'
import { withTransaction } from '../database/pool.js'
import * as sessionRepository from '../repositories/session.repository.js'
import * as userRepository from '../repositories/user.repository.js'
import { ConflictError, NotFoundError } from '../utils/errors.js'
import * as audit from './audit.service.js'
import type { RequestContext } from './auth.service.js'
import { generateTemporaryPassword, hashPassword } from './password.service.js'

/**
 * User accounts, as an administrator manages them on the Users screen.
 *
 * Eight people, not fifty: this is the screen an administrator opens twice a
 * year to add a colleague, reset a password somebody forgot, and - the thing
 * it exists for - see at a glance which HR user has no authorising signature
 * on file, because every document that person uploads comes out partly
 * stamped until they do.
 *
 * PASSWORDS ARE NEVER SEEN OR SET BY THE ADMINISTRATOR. Creating an account
 * and resetting one both generate a temporary password, show it once in the
 * response - the field is named `temporaryPassword` so the logger's
 * redaction catches it if it ever went near a log - and set
 * MustChangePassword, so the person changes it at their next sign-in and
 * nobody but them ever knows the real one. There is deliberately no
 * self-service 'forgot password': the administrator does it for whoever asks.
 *
 * NO DELETE. A user is deactivated, never removed: documents were signed in
 * their name and the audit trail carries it - the same reasoning as archiving
 * an employee rather than deleting one.
 *
 * TWO REFUSALS, ENFORCED HERE AND NOT ONLY HIDDEN ON SCREEN. Nobody may
 * deactivate or demote their own account, and the last active administrator
 * may not be deactivated or moved off ADMIN - otherwise there is no way back
 * in except SQL. One person cannot actually reach the second refusal through
 * the API: the actor is an active administrator, so with another as target
 * the count is at least two, and targeting yourself is refused first. It is
 * the guard against two administrators removing each other in the same
 * instant - the count and the change happen under one transaction, so the
 * second of them sees a count of one and is refused - and against any route
 * added later that forgets the first rule.
 */

export interface CreatedUser {
  user: UserListItem
  /** Shown once. Never stored in this form, never logged, never in the audit trail. */
  temporaryPassword: string
}

function toListItem(record: userRepository.UserListing): UserListItem {
  return {
    userId: record.userId,
    username: record.username,
    fullName: record.fullName,
    role: record.role as Role,
    isActive: record.isActive,
    mustChangePassword: record.mustChangePassword,
    lastLoginAt: record.lastLoginAt?.toISOString() ?? null,
    hasSignature: record.hasSignature,
  }
}

export async function list(): Promise<UserListItem[]> {
  return (await userRepository.listAll()).map(toListItem)
}

async function getListItem(userId: number): Promise<UserListItem> {
  const item = (await list()).find((user) => user.userId === userId)
  if (!item) throw new NotFoundError('That user does not exist.')
  return item
}

export async function create(
  input: CreateUserInput,
  actor: AuthUser,
  context: RequestContext,
): Promise<CreatedUser> {
  if (await userRepository.usernameExists(input.username)) {
    throw new ConflictError(`The username ${input.username} is already taken.`)
  }

  const temporaryPassword = generateTemporaryPassword()
  const userId = await userRepository.createUser({
    username: input.username,
    fullName: input.fullName,
    role: input.role,
    password: await hashPassword(temporaryPassword),
    mustChangePassword: true,
  })

  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.USER_CREATED,
    entityType: AUDIT_ENTITY_TYPES.USER,
    entityId: userId,
    ipAddress: context.ipAddress,
    // Who and what role - never the password, in any form.
    metadata: { username: input.username, role: input.role, source: 'Users screen' },
  })

  return { user: await getListItem(userId), temporaryPassword }
}

/**
 * A fresh temporary password, shown once, changed at next sign-in.
 *
 * Every session the account has is ended: whoever asked for the reset is
 * usually locked out already, and if they are not, a live session on some
 * other machine is exactly what a reset should close.
 */
export async function resetPassword(
  userId: number,
  actor: AuthUser,
  context: RequestContext,
): Promise<{ temporaryPassword: string }> {
  const target = await userRepository.findById(userId)
  if (!target) throw new NotFoundError('That user does not exist.')

  const temporaryPassword = generateTemporaryPassword()
  await userRepository.updatePassword(userId, await hashPassword(temporaryPassword), true)
  await sessionRepository.revokeAllForUser(userId)

  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.USER_PASSWORD_RESET,
    entityType: AUDIT_ENTITY_TYPES.USER,
    entityId: userId,
    ipAddress: context.ipAddress,
    metadata: { username: target.username, byAdministrator: actor.username },
  })

  return { temporaryPassword }
}

/**
 * Changes a user's name, role or active flag.
 *
 * One route for the three things the screen offers - change role,
 * deactivate, reactivate - and the audit action is chosen from what actually
 * changed, so the trail reads 'deactivated' rather than 'updated: isActive
 * false'. Deactivating also ends every session the account has.
 */
export async function update(
  userId: number,
  input: UpdateUserInput,
  actor: AuthUser,
  context: RequestContext,
): Promise<UserListItem> {
  const target = await userRepository.findById(userId)
  if (!target) throw new NotFoundError('That user does not exist.')

  const deactivating = input.isActive === false && target.isActive
  const reactivating = input.isActive === true && !target.isActive
  const demoting =
    input.role !== undefined && target.role === ROLES.ADMIN && input.role !== ROLES.ADMIN
  const roleChanging = input.role !== undefined && input.role !== target.role
  const renaming = input.fullName !== undefined && input.fullName !== target.fullName

  // Your own account is not yours to lock. Deactivating yourself, or taking
  // away your own administration, is the one change nobody can undo from
  // where they are standing.
  if (userId === actor.userId && (deactivating || demoting)) {
    throw new ConflictError('You cannot deactivate or demote your own account.')
  }

  await withTransaction(async (tx) => {
    // The last active administrator stays an active administrator. Counted
    // under the transaction's lock so that two administrators removing each
    // other at the same moment cannot both get through.
    if (target.isActive && target.role === ROLES.ADMIN && (deactivating || demoting)) {
      const admins = await userRepository.countActiveAdmins(tx)
      if (admins <= 1) {
        throw new ConflictError(
          'This is the last active administrator. Make somebody else an administrator first.',
        )
      }
    }

    await userRepository.update(
      userId,
      {
        fullName: renaming ? input.fullName : undefined,
        role: roleChanging ? input.role : undefined,
        isActive: deactivating || reactivating ? input.isActive : undefined,
      },
      tx,
    )
    if (deactivating) await sessionRepository.revokeAllForUser(userId, tx)
  })

  const changes: Record<string, { from: unknown; to: unknown }> = {}
  if (renaming) changes.fullName = { from: target.fullName, to: input.fullName }
  if (roleChanging) changes.role = { from: target.role, to: input.role }

  const action = deactivating
    ? AUDIT_ACTIONS.USER_DEACTIVATED
    : reactivating
      ? AUDIT_ACTIONS.USER_REACTIVATED
      : AUDIT_ACTIONS.USER_UPDATED

  if (deactivating || reactivating || Object.keys(changes).length > 0) {
    await audit.record({
      userId: actor.userId,
      action,
      entityType: AUDIT_ENTITY_TYPES.USER,
      entityId: userId,
      ipAddress: context.ipAddress,
      metadata: { username: target.username, ...(Object.keys(changes).length ? { changes } : {}) },
    })
  }

  return getListItem(userId)
}
