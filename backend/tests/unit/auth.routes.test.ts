import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_ERROR_CODES, ROLES } from '@asps-dms/shared'
import { hashPassword } from '../../src/services/password.service.js'
import type { UserRecord } from '../../src/repositories/user.repository.js'

/**
 * Authentication, end to end over HTTP with the database mocked.
 *
 * The assertions here are mostly about what does NOT happen: the token never
 * appears in a response body, a failed login never says why, and a locked or
 * deactivated account never gets a session.
 */

const db = vi.hoisted(() => ({
  findByUsername: vi.fn(),
  findById: vi.fn(),
  recordSuccessfulLogin: vi.fn(),
  recordFailedLogin: vi.fn(),
  updatePassword: vi.fn(),
  createSession: vi.fn(),
  findByTokenHash: vi.fn(),
  touchSession: vi.fn(),
  revokeSession: vi.fn(),
  revokeAllForUser: vi.fn(),
  insertAudit: vi.fn(),
}))

vi.mock('../../src/repositories/user.repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/repositories/user.repository.js')>()
  return {
    // toAuthUser is a pure mapper and is exercised as itself.
    ...actual,
    findByUsername: db.findByUsername,
    findById: db.findById,
    recordSuccessfulLogin: db.recordSuccessfulLogin,
    recordFailedLogin: db.recordFailedLogin,
    updatePassword: db.updatePassword,
  }
})

vi.mock('../../src/repositories/session.repository.js', () => ({
  create: db.createSession,
  findByTokenHash: db.findByTokenHash,
  touch: db.touchSession,
  revoke: db.revokeSession,
  revokeAllForUser: db.revokeAllForUser,
  deleteExpiredBefore: vi.fn(),
}))

vi.mock('../../src/repositories/audit.repository.js', () => ({ insert: db.insertAudit }))

const { createApp } = await import('../../src/app.js')
const app = createApp()

// asps-dms:allow-secret - fixture credentials for a mocked user, not a real one.
const PASSWORD = 'Correct-Horse-Battery-1'
const storedPassword = await hashPassword(PASSWORD)

const COOKIE_NAME = 'asps_dms_sid'

function userRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    userId: 7,
    username: 'hr1',
    fullName: 'Priya Sharma',
    role: ROLES.HR,
    isActive: true,
    mustChangePassword: false,
    password: storedPassword,
    failedLoginCount: 0,
    lockedUntil: null,
    ...overrides,
  }
}

function liveSession(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    sessionId: 99,
    userId: 7,
    issuedAt: new Date(now - 60_000),
    lastSeenAt: new Date(now - 5_000),
    expiresAt: new Date(now + 60 * 60_000),
    absoluteExpiry: new Date(now + 12 * 60 * 60_000),
    revokedAt: null,
    username: 'hr1',
    fullName: 'Priya Sharma',
    role: ROLES.HR,
    isActive: true,
    mustChangePassword: false,
    ...overrides,
  }
}

function sessionCookie(response: request.Response): string | undefined {
  const header = response.headers['set-cookie']
  const cookies = Array.isArray(header) ? header : header ? [header] : []
  return cookies.find((cookie) => cookie.startsWith(`${COOKIE_NAME}=`))
}

beforeEach(() => {
  vi.clearAllMocks()
  db.createSession.mockResolvedValue(99)
  db.insertAudit.mockResolvedValue(undefined)
  db.recordSuccessfulLogin.mockResolvedValue(undefined)
  db.recordFailedLogin.mockResolvedValue(undefined)
  db.revokeSession.mockResolvedValue(undefined)
  db.revokeAllForUser.mockResolvedValue(0)
  db.touchSession.mockResolvedValue(undefined)
})

describe('POST /api/auth/login', () => {
  it('signs in a valid user and puts the token only in an httpOnly cookie', async () => {
    db.findByUsername.mockResolvedValue(userRecord())

    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'hr1', password: PASSWORD })

    expect(response.status).toBe(200)
    expect(response.body.user).toEqual({
      userId: 7,
      username: 'hr1',
      fullName: 'Priya Sharma',
      role: ROLES.HR,
      mustChangePassword: false,
    })

    const cookie = sessionCookie(response)
    expect(cookie).toBeDefined()
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')

    // The token is in the cookie and nowhere else.
    const cookieValue = cookie?.split(';')[0]?.split('=')[1] ?? ''
    expect(cookieValue.length).toBeGreaterThan(20)
    expect(JSON.stringify(response.body)).not.toContain(cookieValue)

    // Stored as a hash, never in plain form.
    const created = db.createSession.mock.calls[0]?.[0] as { tokenHash: Buffer }
    expect(created.tokenHash.length).toBe(32)
    expect(created.tokenHash.toString('utf8')).not.toContain(cookieValue)
  })

  it('gives the same answer for a wrong password and an unknown username', async () => {
    db.findByUsername.mockResolvedValueOnce(userRecord())
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      // asps-dms:allow-secret - a deliberately wrong fixture password.
      .send({ username: 'hr1', password: 'Wrong-Horse-Battery-9' })

    db.findByUsername.mockResolvedValueOnce(null)
    const unknownUser = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: PASSWORD })

    expect(wrongPassword.status).toBe(401)
    expect(unknownUser.status).toBe(401)
    expect(wrongPassword.body).toEqual(unknownUser.body)
    expect(wrongPassword.body.error.code).toBe(API_ERROR_CODES.UNAUTHENTICATED)
    expect(sessionCookie(wrongPassword)).toBeUndefined()
    expect(db.createSession).not.toHaveBeenCalled()
  })

  it('counts a failed attempt against the account, with the lockout policy', async () => {
    db.findByUsername.mockResolvedValue(userRecord())

    // asps-dms:allow-secret - a deliberately wrong fixture password.
    await request(app).post('/api/auth/login').send({ username: 'hr1', password: 'Wrong-1234' })

    expect(db.recordFailedLogin).toHaveBeenCalledWith(7, 5, 15)
  })

  it('refuses a locked account even when the password is right', async () => {
    db.findByUsername.mockResolvedValue(
      userRecord({ failedLoginCount: 5, lockedUntil: new Date(Date.now() + 10 * 60_000) }),
    )

    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'hr1', password: PASSWORD })

    expect(response.status).toBe(429)
    expect(response.body.error.code).toBe(API_ERROR_CODES.RATE_LIMITED)
    expect(response.body.error.message).toMatch(/minute/)
    expect(db.createSession).not.toHaveBeenCalled()
  })

  it('lets a user back in once the lock has passed', async () => {
    db.findByUsername.mockResolvedValue(
      userRecord({ failedLoginCount: 5, lockedUntil: new Date(Date.now() - 60_000) }),
    )

    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'hr1', password: PASSWORD })

    expect(response.status).toBe(200)
    expect(db.recordSuccessfulLogin).toHaveBeenCalledWith(7)
  })

  it('refuses a deactivated account', async () => {
    db.findByUsername.mockResolvedValue(userRecord({ isActive: false }))

    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'hr1', password: PASSWORD })

    expect(response.status).toBe(401)
    expect(db.createSession).not.toHaveBeenCalled()
  })

  it('reports a first login as needing a password change', async () => {
    db.findByUsername.mockResolvedValue(userRecord({ mustChangePassword: true }))

    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'hr1', password: PASSWORD })

    expect(response.status).toBe(200)
    expect(response.body.user.mustChangePassword).toBe(true)
  })

  it('rejects a malformed body before any lookup', async () => {
    const response = await request(app).post('/api/auth/login').send({ username: '' })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe(API_ERROR_CODES.VALIDATION_FAILED)
    expect(db.findByUsername).not.toHaveBeenCalled()
  })

  it('leaves a hash alone when it is already at the current cost', async () => {
    // The upgrade path itself is covered by needsRehash in password.test.ts;
    // what matters here is that an ordinary login does not rewrite the row.
    db.findByUsername.mockResolvedValue(userRecord())

    await request(app).post('/api/auth/login').send({ username: 'hr1', password: PASSWORD })

    expect(db.updatePassword).not.toHaveBeenCalled()
  })
})

describe('GET /api/auth/me', () => {
  it('refuses a request with no cookie', async () => {
    const response = await request(app).get('/api/auth/me')

    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe(API_ERROR_CODES.UNAUTHENTICATED)
    expect(db.findByTokenHash).not.toHaveBeenCalled()
  })

  it('returns the signed-in user for a live session', async () => {
    db.findByTokenHash.mockResolvedValue(liveSession())

    const response = await request(app).get('/api/auth/me').set('Cookie', `${COOKIE_NAME}=token123`)

    expect(response.status).toBe(200)
    expect(response.body.user.username).toBe('hr1')
    expect(response.body.user.role).toBe(ROLES.HR)
  })

  it('clears the cookie and says the session ended when it is gone', async () => {
    db.findByTokenHash.mockResolvedValue(null)

    const response = await request(app).get('/api/auth/me').set('Cookie', `${COOKIE_NAME}=token123`)

    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe(API_ERROR_CODES.SESSION_EXPIRED)
    expect(sessionCookie(response)).toContain(`${COOKIE_NAME}=;`)
  })

  it('revokes the session of a user who has since been deactivated', async () => {
    db.findByTokenHash.mockResolvedValue(liveSession({ isActive: false }))

    const response = await request(app).get('/api/auth/me').set('Cookie', `${COOKIE_NAME}=token123`)

    expect(response.status).toBe(401)
    expect(db.revokeSession).toHaveBeenCalledWith(99)
  })

  it('extends an idle session at most once a minute', async () => {
    db.findByTokenHash.mockResolvedValue(liveSession({ lastSeenAt: new Date(Date.now() - 5_000) }))
    await request(app).get('/api/auth/me').set('Cookie', `${COOKIE_NAME}=token123`)
    expect(db.touchSession).not.toHaveBeenCalled()

    db.findByTokenHash.mockResolvedValue(
      liveSession({ lastSeenAt: new Date(Date.now() - 5 * 60_000) }),
    )
    await request(app).get('/api/auth/me').set('Cookie', `${COOKIE_NAME}=token123`)
    expect(db.touchSession).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/auth/logout', () => {
  it('revokes the session and clears the cookie', async () => {
    db.findByTokenHash.mockResolvedValue(liveSession())

    const response = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `${COOKIE_NAME}=token123`)

    expect(response.status).toBe(204)
    expect(db.revokeSession).toHaveBeenCalledWith(99)
    expect(sessionCookie(response)).toContain(`${COOKIE_NAME}=;`)
  })
})

describe('POST /api/auth/change-password', () => {
  const body = {
    currentPassword: PASSWORD,
    newPassword: 'Brand-New-Password-2',
    confirmPassword: 'Brand-New-Password-2',
  }

  it('changes the password, ends every other session and re-issues this one', async () => {
    db.findByTokenHash.mockResolvedValue(liveSession({ mustChangePassword: true }))
    db.findById.mockResolvedValue(userRecord({ mustChangePassword: true }))
    db.revokeAllForUser.mockResolvedValue(3)

    const response = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', `${COOKIE_NAME}=token123`)
      .send(body)

    expect(response.status).toBe(200)
    expect(response.body.user.mustChangePassword).toBe(false)
    expect(db.revokeAllForUser).toHaveBeenCalledWith(7)
    expect(db.createSession).toHaveBeenCalledTimes(1)
    expect(sessionCookie(response)).toContain('HttpOnly')

    // MustChangePassword is cleared as part of the same write.
    expect(db.updatePassword).toHaveBeenCalledWith(7, expect.anything(), false)
  })

  it('rejects a wrong current password against that field, changing nothing', async () => {
    db.findByTokenHash.mockResolvedValue(liveSession())
    db.findById.mockResolvedValue(userRecord())

    const response = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', `${COOKIE_NAME}=token123`)
      .send({ ...body, currentPassword: 'Not-The-Password-9' })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe(API_ERROR_CODES.VALIDATION_FAILED)
    expect(response.body.error.details.issues[0].path).toBe('currentPassword')
    expect(db.updatePassword).not.toHaveBeenCalled()
    expect(db.revokeAllForUser).not.toHaveBeenCalled()
  })

  it('enforces the shared password policy on the new password', async () => {
    db.findByTokenHash.mockResolvedValue(liveSession())
    db.findById.mockResolvedValue(userRecord())

    const response = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', `${COOKIE_NAME}=token123`)
      .send({ currentPassword: PASSWORD, newPassword: 'short', confirmPassword: 'short' })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe(API_ERROR_CODES.VALIDATION_FAILED)
    expect(db.findById).not.toHaveBeenCalled()
  })

  it('requires a session', async () => {
    const response = await request(app).post('/api/auth/change-password').send(body)

    expect(response.status).toBe(401)
  })
})
