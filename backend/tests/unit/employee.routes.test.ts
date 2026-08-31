import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_ERROR_CODES, ROLES, type Role } from '@asps-dms/shared'

/**
 * The employee routes, over HTTP with the database mocked.
 *
 * What is asserted here is the boundary rather than the behaviour: who is
 * allowed through, what a bad id does, and that a read-only role cannot write.
 * The frontend hides the buttons a Viewer must not press; these are the checks
 * that actually stop them.
 */

const db = vi.hoisted(() => ({
  findByTokenHash: vi.fn(),
  touchSession: vi.fn(),
  revokeSession: vi.fn(),
  listEmployees: vi.fn(),
  findEmployee: vi.fn(),
  createEmployee: vi.fn(),
  updateEmployee: vi.fn(),
  setActive: vi.fn(),
  listFacets: vi.fn(),
  listActiveTypes: vi.fn(),
  listAllTypes: vi.fn(),
  createChecklist: vi.fn(),
  listForEmployee: vi.fn(),
  insertAudit: vi.fn(),
}))

vi.mock('../../src/database/pool.js', () => ({
  withTransaction: async <T>(work: (tx: unknown) => Promise<T>) => work({}),
}))

vi.mock('../../src/repositories/session.repository.js', () => ({
  create: vi.fn(),
  findByTokenHash: db.findByTokenHash,
  touch: db.touchSession,
  revoke: db.revokeSession,
  revokeAllForUser: vi.fn(),
  deleteExpiredBefore: vi.fn(),
}))

vi.mock('../../src/repositories/employee.repository.js', () => ({
  list: db.listEmployees,
  findById: db.findEmployee,
  create: db.createEmployee,
  update: db.updateEmployee,
  setActive: db.setActive,
  listFacets: db.listFacets,
}))

vi.mock('../../src/repositories/documentType.repository.js', () => ({
  listActive: db.listActiveTypes,
  listAll: db.listAllTypes,
  findById: vi.fn(),
}))

vi.mock('../../src/repositories/employeeDocument.repository.js', () => ({
  createChecklist: db.createChecklist,
  listForEmployee: db.listForEmployee,
  listDocumentTypeIdsForEmployee: vi.fn(),
}))

vi.mock('../../src/repositories/audit.repository.js', () => ({ insert: db.insertAudit }))

const { createApp } = await import('../../src/app.js')
const app = createApp()

const COOKIE_NAME = 'asps_dms_sid'
const TOKEN = 'a'.repeat(64)

function signedInAs(role: Role, mustChangePassword = false) {
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
    mustChangePassword,
  })
  return [`${COOKIE_NAME}=${TOKEN}`]
}

const profile = {
  employeeId: 42,
  employeeCode: 'EMP001',
  employeeName: 'Ravi Kumar',
  joiningDate: '2026-09-01',
  department: 'Accounts',
  designation: null,
  isActive: true,
  createdAt: '2026-09-01T04:00:00.000Z',
  updatedAt: '2026-09-01T04:00:00.000Z',
  counts: { total: 0, completed: 0, pending: 0, overdue: 0, signatureReviewRequired: 0 },
  hasSignature: false,
  signatureUpdatedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  db.insertAudit.mockResolvedValue(undefined)
  db.touchSession.mockResolvedValue(undefined)
  db.findEmployee.mockResolvedValue(profile)
  db.listActiveTypes.mockResolvedValue([])
  db.createChecklist.mockResolvedValue(0)
  db.createEmployee.mockResolvedValue({ employeeId: 42, employeeCode: 'EMP001' })
  db.listEmployees.mockResolvedValue({
    items: [],
    page: 1,
    pageSize: 25,
    totalCount: 0,
    totalPages: 1,
  })
})

describe('authentication', () => {
  it('refuses an unauthenticated request without touching the database', async () => {
    const response = await request(app).get('/api/employees')

    expect(response.status).toBe(401)
    expect(db.listEmployees).not.toHaveBeenCalled()
  })

  it('refuses an account that still has to change its password', async () => {
    const cookie = signedInAs(ROLES.HR, true)

    const response = await request(app).get('/api/employees').set('Cookie', cookie)

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe(API_ERROR_CODES.PASSWORD_CHANGE_REQUIRED)
    expect(db.listEmployees).not.toHaveBeenCalled()
  })
})

describe('permissions', () => {
  it('lets a Viewer read the employee list', async () => {
    const response = await request(app)
      .get('/api/employees')
      .set('Cookie', signedInAs(ROLES.VIEWER))

    expect(response.status).toBe(200)
    expect(response.body.totalCount).toBe(0)
  })

  it('stops a Viewer creating an employee', async () => {
    const response = await request(app)
      .post('/api/employees')
      .set('Cookie', signedInAs(ROLES.VIEWER))
      .send({ employeeName: 'Ravi Kumar', joiningDate: '2026-09-01' })

    expect(response.status).toBe(403)
    expect(db.createEmployee).not.toHaveBeenCalled()
  })

  it('stops a Viewer archiving an employee', async () => {
    const response = await request(app)
      .post('/api/employees/42/archive')
      .set('Cookie', signedInAs(ROLES.VIEWER))

    expect(response.status).toBe(403)
    expect(db.setActive).not.toHaveBeenCalled()
  })

  it('lets HR create an employee and answers 201 with the new record', async () => {
    const response = await request(app)
      .post('/api/employees')
      .set('Cookie', signedInAs(ROLES.HR))
      .send({ employeeName: 'Ravi Kumar', joiningDate: '2026-09-01', department: 'Accounts' })

    expect(response.status).toBe(201)
    expect(response.body.employee.employeeCode).toBe('EMP001')
  })
})

describe('validation', () => {
  it('rejects a missing joining date with field-level issues', async () => {
    const response = await request(app)
      .post('/api/employees')
      .set('Cookie', signedInAs(ROLES.HR))
      .send({ employeeName: 'Ravi Kumar' })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe(API_ERROR_CODES.VALIDATION_FAILED)
    expect(response.body.error.details.issues[0].path).toBe('joiningDate')
    expect(db.createEmployee).not.toHaveBeenCalled()
  })

  it('rejects a calendar date that does not exist', async () => {
    const response = await request(app)
      .post('/api/employees')
      .set('Cookie', signedInAs(ROLES.HR))
      .send({ employeeName: 'Ravi Kumar', joiningDate: '2026-02-30' })

    expect(response.status).toBe(400)
    expect(db.createEmployee).not.toHaveBeenCalled()
  })

  it('never lets a client choose the employee code', async () => {
    await request(app)
      .post('/api/employees')
      .set('Cookie', signedInAs(ROLES.HR))
      .send({
        employeeName: 'Ravi Kumar',
        joiningDate: '2026-09-01',
        employeeCode: 'EMP999',
      })

    // The schema strips it, so it never reaches the repository at all.
    expect(db.createEmployee.mock.calls[0]?.[0]).not.toHaveProperty('employeeCode')
  })

  it('rejects an id that is not a positive integer', async () => {
    const response = await request(app)
      .get('/api/employees/not-a-number')
      .set('Cookie', signedInAs(ROLES.HR))

    expect(response.status).toBe(400)
    expect(db.findEmployee).not.toHaveBeenCalled()
  })

  it('answers 404 for an employee that does not exist', async () => {
    db.findEmployee.mockResolvedValue(null)

    const response = await request(app)
      .get('/api/employees/999')
      .set('Cookie', signedInAs(ROLES.HR))

    expect(response.status).toBe(404)
  })

  it('reads /employees/facets as a route, not as an employee id', async () => {
    db.listFacets.mockResolvedValue({ departments: ['Accounts'], designations: [] })

    const response = await request(app)
      .get('/api/employees/facets')
      .set('Cookie', signedInAs(ROLES.HR))

    expect(response.status).toBe(200)
    expect(response.body.departments).toEqual(['Accounts'])
  })

  it('treats includeArchived=false as false rather than as a non-empty string', async () => {
    await request(app)
      .get('/api/employees?includeArchived=false')
      .set('Cookie', signedInAs(ROLES.HR))

    expect(db.listEmployees.mock.calls[0]?.[0].includeArchived).toBe(false)
  })
})
