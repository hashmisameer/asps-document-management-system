import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROLES, type Role } from '@asps-dms/shared'

/**
 * The documents list over HTTP: the page every dashboard document tile opens.
 *
 * The boundary is what is asserted - who may read it, and that the filter in the
 * link reaches the query. A Viewer must be able to open it and must not be able
 * to change anything on it.
 */

const db = vi.hoisted(() => ({
  findByTokenHash: vi.fn(),
  touchSession: vi.fn(),
  listAll: vi.fn(),
}))

vi.mock('../../src/database/pool.js', () => ({
  withTransaction: async <T>(work: (tx: unknown) => Promise<T>) => work({}),
}))

vi.mock('../../src/repositories/session.repository.js', () => ({
  create: vi.fn(),
  findByTokenHash: db.findByTokenHash,
  touch: db.touchSession,
  revoke: vi.fn(),
  revokeAllForUser: vi.fn(),
  deleteExpiredBefore: vi.fn(),
}))

vi.mock('../../src/repositories/employeeDocument.repository.js', () => ({
  listAll: db.listAll,
  listForEmployee: vi.fn(),
  findById: vi.fn(),
  createChecklist: vi.fn(),
  listDocumentTypeIdsForEmployee: vi.fn(),
}))

const { createApp } = await import('../../src/app.js')
const app = createApp()

const COOKIE_NAME = 'asps_dms_sid'
const TOKEN = 'a'.repeat(64)

function signedInAs(role: Role) {
  const now = Date.now()
  db.findByTokenHash.mockResolvedValue({
    sessionId: 1,
    userId: 7,
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

const row = {
  documentId: 1,
  employeeId: 42,
  employeeCode: 'EMP001',
  employeeName: 'Ravi Kumar',
  department: 'CUTTING',
  designation: 'ASSTT. OPERATOR',
  documentTypeId: 5,
  documentName: 'PF Form',
  isMandatory: false,
  status: 'Pending',
  hasFile: false,
  dueDate: '2026-08-20',
  uploadedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  db.touchSession.mockResolvedValue(undefined)
  db.listAll.mockResolvedValue({ rows: [row], total: 1 })
})

describe('the documents list', () => {
  it('lets a Viewer read it', async () => {
    const response = await request(app)
      .get('/api/documents')
      .set('Cookie', signedInAs(ROLES.VIEWER))

    expect(response.status).toBe(200)
    expect(response.body.items).toHaveLength(1)
    expect(response.body.totalCount).toBe(1)
  })

  it('names an employee AND a document on every line', async () => {
    // The dashboard's document tiles count rows, so the list they open has to
    // say which document as well as whose.
    const response = await request(app)
      .get('/api/documents')
      .set('Cookie', signedInAs(ROLES.VIEWER))

    expect(response.body.items[0]).toMatchObject({
      employeeName: 'Ravi Kumar',
      employeeCode: 'EMP001',
      documentName: 'PF Form',
    })
  })

  it('derives the deadline rather than trusting a stored flag', async () => {
    db.listAll.mockResolvedValue({
      rows: [{ ...row, dueDate: '2020-01-01' }],
      total: 1,
    })

    const response = await request(app)
      .get('/api/documents?state=overdue')
      .set('Cookie', signedInAs(ROLES.VIEWER))

    expect(response.body.items[0].deadlineState).toBe('Overdue')
    expect(response.body.items[0].daysRemaining).toBeLessThan(0)
  })

  it('passes the state in the link through to the query', async () => {
    await request(app)
      .get('/api/documents?state=dueSoon&department=CUTTING&page=2')
      .set('Cookie', signedInAs(ROLES.HR))

    expect(db.listAll).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'dueSoon', department: 'CUTTING', page: 2 }),
    )
  })

  it('refuses a state it does not know rather than quietly showing everything', async () => {
    const response = await request(app)
      .get('/api/documents?state=whatever')
      .set('Cookie', signedInAs(ROLES.HR))

    expect(response.status).toBe(400)
    expect(db.listAll).not.toHaveBeenCalled()
  })

  it('answers an empty list as an empty list, not as an error', async () => {
    db.listAll.mockResolvedValue({ rows: [], total: 0 })

    const response = await request(app)
      .get('/api/documents?state=overdue')
      .set('Cookie', signedInAs(ROLES.VIEWER))

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ items: [], totalCount: 0, totalPages: 1 })
  })

  it('refuses an unauthenticated request', async () => {
    const response = await request(app).get('/api/documents')

    expect(response.status).toBe(401)
    expect(db.listAll).not.toHaveBeenCalled()
  })
})
