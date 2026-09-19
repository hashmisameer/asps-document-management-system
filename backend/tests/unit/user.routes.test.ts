import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROLES, type Role } from '@asps-dms/shared'

/**
 * The Users routes over HTTP: who gets in, what comes back, and what does
 * not exist.
 *
 * The rules themselves are pinned in user.service.test.ts. Here: every route
 * is an administrator's and nobody else's; a created account arrives with its
 * temporary password once and no password material otherwise; there is no
 * DELETE.
 */

const db = vi.hoisted(() => ({
  findByTokenHash: vi.fn(),
  touchSession: vi.fn(),
  revokeAllForUser: vi.fn(),
  listAll: vi.fn(),
  findById: vi.fn(),
  usernameExists: vi.fn(),
  createUser: vi.fn(),
  updatePassword: vi.fn(),
  update: vi.fn(),
  countActiveAdmins: vi.fn(),
  insertAudit: vi.fn(),
}))

vi.mock('../../src/database/pool.js', () => ({
  withTransaction: async (work: (tx: unknown) => Promise<unknown>) => work({}),
  createRequest: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  sql: {},
}))
vi.mock('../../src/repositories/session.repository.js', () => ({
  findByTokenHash: db.findByTokenHash,
  touch: db.touchSession,
  revoke: vi.fn(),
  revokeAllForUser: db.revokeAllForUser,
  create: vi.fn(),
}))
vi.mock('../../src/repositories/user.repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/repositories/user.repository.js')>()
  return {
    ...actual,
    listAll: db.listAll,
    findById: db.findById,
    usernameExists: db.usernameExists,
    createUser: db.createUser,
    updatePassword: db.updatePassword,
    update: db.update,
    countActiveAdmins: db.countActiveAdmins,
  }
})
vi.mock('../../src/repositories/audit.repository.js', () => ({ insert: db.insertAudit }))

const { createApp } = await import('../../src/app.js')
const app = createApp()

const COOKIE_NAME = 'asps_dms_sid'
const TOKEN = 'a'.repeat(64)

function signedInAs(role: Role, userId = 7) {
  const now = Date.now()
  db.findByTokenHash.mockResolvedValue({
    sessionId: 1,
    userId,
    issuedAt: new Date(now - 60_000),
    lastSeenAt: new Date(now - 5_000),
    expiresAt: new Date(now + 60 * 60_000),
    absoluteExpiry: new Date(now + 12 * 60 * 60_000),
    revokedAt: null,
    username: 'user1',
    fullName: 'Test User',
    role,
    isActive: true,
    mustChangePassword: false,
  })
  return [`${COOKIE_NAME}=${TOKEN}`]
}

const listing = {
  userId: 8,
  username: 'hr2',
  fullName: 'New Person',
  role: 'HR',
  isActive: true,
  mustChangePassword: true,
  lastLoginAt: null,
  hasSignature: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  db.touchSession.mockResolvedValue(undefined)
  db.insertAudit.mockResolvedValue(undefined)
  db.revokeAllForUser.mockResolvedValue(0)
  db.listAll.mockResolvedValue([listing])
  db.usernameExists.mockResolvedValue(false)
  db.createUser.mockResolvedValue(8)
  db.update.mockResolvedValue(true)
  db.countActiveAdmins.mockResolvedValue(2)
  db.findById.mockResolvedValue({
    userId: 8,
    username: 'hr2',
    fullName: 'New Person',
    role: 'HR',
    isActive: true,
    mustChangePassword: true,
    password: { hash: Buffer.alloc(32), salt: Buffer.alloc(16), algorithm: 'scrypt' },
    failedLoginCount: 0,
    lockedUntil: null,
  })
})

describe('who may manage users', () => {
  it.each([ROLES.HR, ROLES.VIEWER])('refuses %s on every route', async (role) => {
    const cookie = signedInAs(role)

    expect((await request(app).get('/api/users').set('Cookie', cookie)).status).toBe(403)
    expect(
      (
        await request(app)
          .post('/api/users')
          .set('Cookie', cookie)
          .send({ username: 'x1', fullName: 'X', role: 'HR' })
      ).status,
    ).toBe(403)
    expect(
      (await request(app).patch('/api/users/8').set('Cookie', cookie).send({ isActive: false }))
        .status,
    ).toBe(403)
    expect(
      (await request(app).post('/api/users/8/reset-password').set('Cookie', cookie)).status,
    ).toBe(403)
    expect(db.createUser).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  it('refuses a request with no session', async () => {
    expect((await request(app).get('/api/users')).status).toBe(401)
  })
})

describe('as an administrator', () => {
  it('lists users with no password material', async () => {
    const response = await request(app).get('/api/users').set('Cookie', signedInAs(ROLES.ADMIN))

    expect(response.status).toBe(200)
    expect(response.body.users).toHaveLength(1)
    expect(response.body.users[0]).toMatchObject({ username: 'hr2', hasSignature: false })
    expect(JSON.stringify(response.body)).not.toMatch(/"(hash|salt|algorithm|passwordHash)"/i)
  })

  it('creates a user and returns the temporary password once, with 201', async () => {
    const response = await request(app)
      .post('/api/users')
      .set('Cookie', signedInAs(ROLES.ADMIN))
      .send({ username: 'hr2', fullName: 'New Person', role: 'HR' })

    expect(response.status).toBe(201)
    expect(response.body.user.username).toBe('hr2')
    expect(response.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{12,}$/)
    // The list afterwards carries no trace of it.
    const list = await request(app).get('/api/users').set('Cookie', signedInAs(ROLES.ADMIN))
    expect(JSON.stringify(list.body)).not.toContain(response.body.temporaryPassword)
  })

  it('validates the body with the shared schema', async () => {
    const response = await request(app)
      .post('/api/users')
      .set('Cookie', signedInAs(ROLES.ADMIN))
      .send({ username: 'no spaces here', fullName: '', role: 'BOSS' })

    expect(response.status).toBe(400)
    const paths = (response.body.error.details.issues as { path: string }[]).map((i) => i.path)
    expect(paths).toEqual(expect.arrayContaining(['username', 'fullName', 'role']))
    expect(db.createUser).not.toHaveBeenCalled()
  })

  it('answers 409 for a username that is taken', async () => {
    db.usernameExists.mockResolvedValue(true)

    const response = await request(app)
      .post('/api/users')
      .set('Cookie', signedInAs(ROLES.ADMIN))
      .send({ username: 'hr2', fullName: 'New Person', role: 'HR' })

    expect(response.status).toBe(409)
  })

  it('resets a password and returns the new temporary one once', async () => {
    const response = await request(app)
      .post('/api/users/8/reset-password')
      .set('Cookie', signedInAs(ROLES.ADMIN))

    expect(response.status).toBe(200)
    expect(response.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{12,}$/)
    expect(db.revokeAllForUser).toHaveBeenCalledWith(8)
  })

  it('deactivates through PATCH', async () => {
    const response = await request(app)
      .patch('/api/users/8')
      .set('Cookie', signedInAs(ROLES.ADMIN))
      .send({ isActive: false })

    expect(response.status).toBe(200)
    expect(db.update).toHaveBeenCalledWith(
      8,
      expect.objectContaining({ isActive: false }),
      expect.anything(),
    )
  })

  it('refuses to deactivate your own account, as a 409 with the reason', async () => {
    db.findById.mockResolvedValue({
      userId: 7,
      username: 'user1',
      fullName: 'Test User',
      role: 'ADMIN',
      isActive: true,
      mustChangePassword: false,
      password: { hash: Buffer.alloc(32), salt: Buffer.alloc(16), algorithm: 'scrypt' },
      failedLoginCount: 0,
      lockedUntil: null,
    })

    const response = await request(app)
      .patch('/api/users/7')
      .set('Cookie', signedInAs(ROLES.ADMIN, 7))
      .send({ isActive: false })

    expect(response.status).toBe(409)
    expect(response.body.error.message).toBe('You cannot deactivate or demote your own account.')
  })

  it('has no DELETE - a user is deactivated, never removed', async () => {
    const response = await request(app)
      .delete('/api/users/8')
      .set('Cookie', signedInAs(ROLES.ADMIN))
    expect(response.status).toBe(404)
    expect(db.update).not.toHaveBeenCalled()
  })
})
