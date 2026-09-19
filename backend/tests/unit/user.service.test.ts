import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIT_ACTIONS, ROLES, type AuthUser } from '@asps-dms/shared'
import type { UserListing, UserRecord } from '../../src/repositories/user.repository.js'

/**
 * Managing user accounts: the rules an administrator cannot bypass from the
 * screen, with the database stood in.
 *
 * Passwords are generated, hashed, returned once and never audited; a reset
 * ends every session; deactivating ends every session and is refused for
 * yourself and for the last active administrator; demoting likewise; and
 * each change writes the audit action that says what it was.
 */

const db = vi.hoisted(() => ({
  findById: vi.fn(),
  usernameExists: vi.fn(),
  createUser: vi.fn(),
  updatePassword: vi.fn(),
  update: vi.fn(),
  countActiveAdmins: vi.fn(),
  listAll: vi.fn(),
  revokeAllForUser: vi.fn(),
  insertAudit: vi.fn(),
}))

vi.mock('../../src/database/pool.js', () => ({
  withTransaction: async (work: (tx: unknown) => Promise<unknown>) => work({ fake: 'tx' }),
  createRequest: vi.fn(),
  getPool: vi.fn(),
  sql: {},
}))
vi.mock('../../src/repositories/user.repository.js', () => ({
  findById: db.findById,
  usernameExists: db.usernameExists,
  createUser: db.createUser,
  updatePassword: db.updatePassword,
  update: db.update,
  countActiveAdmins: db.countActiveAdmins,
  listAll: db.listAll,
}))
vi.mock('../../src/repositories/session.repository.js', () => ({
  revokeAllForUser: db.revokeAllForUser,
}))
vi.mock('../../src/repositories/audit.repository.js', () => ({ insert: db.insertAudit }))

const userService = await import('../../src/services/user.service.js')

const admin: AuthUser = {
  userId: 1,
  username: 'admin',
  fullName: 'Administrator',
  role: ROLES.ADMIN,
  mustChangePassword: false,
}
const context = { ipAddress: '10.0.0.5', userAgent: 'test' }

function record(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    userId: 7,
    username: 'hr1',
    fullName: 'Priya Sharma',
    role: ROLES.HR,
    isActive: true,
    mustChangePassword: false,
    password: { hash: Buffer.alloc(32), salt: Buffer.alloc(16), algorithm: 'scrypt' },
    failedLoginCount: 0,
    lockedUntil: null,
    ...overrides,
  }
}

function listing(overrides: Partial<UserListing> = {}): UserListing {
  return {
    userId: 7,
    username: 'hr1',
    fullName: 'Priya Sharma',
    role: ROLES.HR,
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: null,
    hasSignature: false,
    ...overrides,
  }
}

const auditEntries = () =>
  db.insertAudit.mock.calls.map((call) => call[0] as { action: string; metadataJson: string })

beforeEach(() => {
  vi.clearAllMocks()
  db.insertAudit.mockResolvedValue(undefined)
  db.revokeAllForUser.mockResolvedValue(1)
  db.update.mockResolvedValue(true)
  db.updatePassword.mockResolvedValue(undefined)
  db.countActiveAdmins.mockResolvedValue(2)
  db.listAll.mockResolvedValue([
    listing({ userId: 1, username: 'admin', role: ROLES.ADMIN }),
    listing(),
  ])
})

describe('creating a user', () => {
  it('generates a temporary password, stores its hash, forces a change, and returns it once', async () => {
    db.usernameExists.mockResolvedValue(false)
    db.createUser.mockResolvedValue(7)

    const created = await userService.create(
      { username: 'hr1', fullName: 'Priya Sharma', role: ROLES.HR },
      admin,
      context,
    )

    expect(created.temporaryPassword).toMatch(/^[A-Za-z0-9]{12,}$/)
    const stored = db.createUser.mock.calls[0]?.[0] as {
      mustChangePassword: boolean
      password: { hash: Buffer }
    }
    expect(stored.mustChangePassword).toBe(true)
    expect(stored.password.hash).toBeInstanceOf(Buffer)
    expect(created.user.username).toBe('hr1')
  })

  it('never writes the password, in any form, to the audit trail', async () => {
    db.usernameExists.mockResolvedValue(false)
    db.createUser.mockResolvedValue(7)

    const created = await userService.create(
      { username: 'hr1', fullName: 'Priya Sharma', role: ROLES.HR },
      admin,
      context,
    )

    const [entry] = auditEntries()
    expect(entry?.action).toBe(AUDIT_ACTIONS.USER_CREATED)
    expect(entry?.metadataJson).not.toContain(created.temporaryPassword)
    expect(entry?.metadataJson.toLowerCase()).not.toContain('password')
  })

  it('refuses a username that is taken, as a 409', async () => {
    db.usernameExists.mockResolvedValue(true)

    await expect(
      userService.create({ username: 'hr1', fullName: 'X', role: ROLES.HR }, admin, context),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(db.createUser).not.toHaveBeenCalled()
  })
})

describe('resetting a password', () => {
  it('hashes a fresh temporary password, forces a change, ends every session, and audits it', async () => {
    db.findById.mockResolvedValue(record())

    const result = await userService.resetPassword(7, admin, context)

    expect(result.temporaryPassword).toMatch(/^[A-Za-z0-9]{12,}$/)
    expect(db.updatePassword).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ hash: expect.any(Buffer), salt: expect.any(Buffer) }),
      true,
    )
    expect(db.revokeAllForUser).toHaveBeenCalledWith(7)
    expect(auditEntries()[0]?.action).toBe(AUDIT_ACTIONS.USER_PASSWORD_RESET)
    expect(auditEntries()[0]?.metadataJson).not.toContain(result.temporaryPassword)
  })

  it('404s for a user that does not exist', async () => {
    db.findById.mockResolvedValue(null)
    await expect(userService.resetPassword(99, admin, context)).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})

describe('deactivating and reactivating', () => {
  it('deactivates, ends every session, and audits USER_DEACTIVATED', async () => {
    db.findById.mockResolvedValue(record())

    await userService.update(7, { isActive: false }, admin, context)

    expect(db.update).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ isActive: false }),
      expect.anything(),
    )
    expect(db.revokeAllForUser).toHaveBeenCalledWith(7, expect.anything())
    expect(auditEntries()[0]?.action).toBe(AUDIT_ACTIONS.USER_DEACTIVATED)
  })

  it('reactivates without touching the password, and audits USER_REACTIVATED', async () => {
    db.findById.mockResolvedValue(record({ isActive: false }))

    await userService.update(7, { isActive: true }, admin, context)

    expect(db.update).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ isActive: true }),
      expect.anything(),
    )
    expect(db.updatePassword).not.toHaveBeenCalled()
    expect(db.revokeAllForUser).not.toHaveBeenCalled()
    expect(auditEntries()[0]?.action).toBe(AUDIT_ACTIONS.USER_REACTIVATED)
  })

  it('refuses to deactivate your own account', async () => {
    db.findById.mockResolvedValue(record({ userId: 1, username: 'admin', role: ROLES.ADMIN }))

    await expect(userService.update(1, { isActive: false }, admin, context)).rejects.toMatchObject({
      statusCode: 409,
      message: 'You cannot deactivate or demote your own account.',
    })
    expect(db.update).not.toHaveBeenCalled()
  })

  it('refuses to deactivate the last active administrator', async () => {
    db.findById.mockResolvedValue(record({ userId: 2, username: 'admin2', role: ROLES.ADMIN }))
    db.countActiveAdmins.mockResolvedValue(1)

    await expect(userService.update(2, { isActive: false }, admin, context)).rejects.toMatchObject({
      statusCode: 409,
      message: 'This is the last active administrator. Make somebody else an administrator first.',
    })
    expect(db.update).not.toHaveBeenCalled()
  })

  it('lets an administrator be deactivated when another remains', async () => {
    db.findById.mockResolvedValue(record({ userId: 2, username: 'admin2', role: ROLES.ADMIN }))
    db.countActiveAdmins.mockResolvedValue(2)
    db.listAll.mockResolvedValue([
      listing({ userId: 1, username: 'admin', role: ROLES.ADMIN }),
      listing({ userId: 2, username: 'admin2', role: ROLES.ADMIN, isActive: false }),
    ])

    await userService.update(2, { isActive: false }, admin, context)
    expect(db.update).toHaveBeenCalled()
  })

  it('never counts administrators when deactivating somebody who is not one', async () => {
    db.findById.mockResolvedValue(record())
    db.countActiveAdmins.mockResolvedValue(1)

    await userService.update(7, { isActive: false }, admin, context)
    expect(db.countActiveAdmins).not.toHaveBeenCalled()
  })
})

describe('changing a role', () => {
  it('records what it was and what it became', async () => {
    db.findById.mockResolvedValue(record())

    await userService.update(7, { role: ROLES.ADMIN }, admin, context)

    const [entry] = auditEntries()
    expect(entry?.action).toBe(AUDIT_ACTIONS.USER_UPDATED)
    expect(JSON.parse(entry?.metadataJson ?? '{}')).toMatchObject({
      changes: { role: { from: 'HR', to: 'ADMIN' } },
    })
  })

  it('refuses to demote your own account', async () => {
    db.findById.mockResolvedValue(record({ userId: 1, username: 'admin', role: ROLES.ADMIN }))

    await expect(userService.update(1, { role: ROLES.HR }, admin, context)).rejects.toMatchObject({
      statusCode: 409,
    })
  })

  it('refuses to demote the last active administrator', async () => {
    db.findById.mockResolvedValue(record({ userId: 2, username: 'admin2', role: ROLES.ADMIN }))
    db.countActiveAdmins.mockResolvedValue(1)

    await expect(userService.update(2, { role: ROLES.HR }, admin, context)).rejects.toMatchObject({
      statusCode: 409,
    })
  })

  it('writes nothing to the audit trail when nothing changed', async () => {
    db.findById.mockResolvedValue(record())

    await userService.update(7, { role: ROLES.HR, fullName: 'Priya Sharma' }, admin, context)

    expect(db.insertAudit).not.toHaveBeenCalled()
  })

  it('renames, and records the old and new name', async () => {
    db.findById.mockResolvedValue(record())

    await userService.update(7, { fullName: 'Priya S. Sharma' }, admin, context)

    expect(JSON.parse(auditEntries()[0]?.metadataJson ?? '{}')).toMatchObject({
      changes: { fullName: { from: 'Priya Sharma', to: 'Priya S. Sharma' } },
    })
  })
})

describe('the list', () => {
  it('carries no password material and says who has a signature', async () => {
    const users = await userService.list()

    expect(users).toHaveLength(2)
    // Field names that would carry a secret: the hash, the salt, the
    // algorithm, or a password itself. mustChangePassword is a flag, not one.
    expect(JSON.stringify(users)).not.toMatch(/"(hash|salt|algorithm|password|passwordHash)"/i)
    expect(users[1]).toMatchObject({ username: 'hr1', hasSignature: false, lastLoginAt: null })
  })
})
