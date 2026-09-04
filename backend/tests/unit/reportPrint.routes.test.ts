import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROLES, type Role } from '@asps-dms/shared'

/**
 * Printing a document's chase list, over HTTP with the database mocked.
 *
 * What is asserted here is the boundary: who may print one, and that the
 * filters typed on the screen arrive at the query unchanged while the paging
 * does not. The screen shows 25 rows; the sheet must hold all of them.
 */

const db = vi.hoisted(() => ({
  findByTokenHash: vi.fn(),
  touchSession: vi.fn(),
  findDocumentType: vi.fn(),
  allEmployees: vi.fn(),
  pagedEmployees: vi.fn(),
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

vi.mock('../../src/repositories/documentType.repository.js', () => ({
  findById: db.findDocumentType,
  listActive: vi.fn(),
  listAll: vi.fn(),
}))

vi.mock('../../src/repositories/report.repository.js', () => ({
  allEmployeesForDocumentType: db.allEmployees,
  employeesForDocumentType: db.pagedEmployees,
  byDocumentType: vi.fn(),
  outstanding: vi.fn(),
  exits: vi.fn(),
  exitsByDepartment: vi.fn(),
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

const PRINT_URL = '/api/reports/by-document-type/5/employees/print'

beforeEach(() => {
  vi.clearAllMocks()
  db.touchSession.mockResolvedValue(undefined)
  db.findDocumentType.mockResolvedValue({
    documentTypeId: 5,
    documentName: 'PF Form',
    documentCode: 'PF_FORM',
    isMandatory: true,
  })
  db.allEmployees.mockResolvedValue([
    {
      employeeId: 1,
      employeeCode: 'EMP-1001',
      employeeName: 'BHAGWAN SINGH',
      department: 'CUTTING',
      designation: 'ASSTT. OPERATOR',
      state: 'Overdue',
      dueDate: '2026-08-20',
      daysOverdue: 14,
    },
  ])
})

describe('printing a document chase list', () => {
  it('lets a Viewer print one, and names the file after the document and the day', async () => {
    const response = await request(app)
      .get(PRINT_URL)
      .set('Cookie', signedInAs(ROLES.VIEWER))

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('application/pdf')
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="PF_Form_pending_[0-9]{4}-[0-9]{2}-[0-9]{2}\.pdf"$/,
    )
    expect(response.body.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('never lets a list of names sit in a shared cache', async () => {
    const response = await request(app).get(PRINT_URL).set('Cookie', signedInAs(ROLES.VIEWER))

    expect(response.headers['cache-control']).toBe('private, no-store')
  })

  it('passes the screen filters and sort through, and asks for every row', async () => {
    await request(app)
      .get(`${PRINT_URL}?department=CUTTING&onlyOverdue=true&sortBy=employeeName&sortDir=desc`)
      .set('Cookie', signedInAs(ROLES.HR))

    expect(db.allEmployees).toHaveBeenCalledWith({
      documentTypeId: 5,
      department: 'CUTTING',
      onlyOverdue: true,
      outstandingOnly: true,
      sortBy: 'employeeName',
      sortDir: 'desc',
    })
    // The paged query belongs to the screen; a printed list never uses it.
    expect(db.pagedEmployees).not.toHaveBeenCalled()
  })

  it('ignores a page number a caller sends anyway', async () => {
    await request(app)
      .get(`${PRINT_URL}?page=3&pageSize=25`)
      .set('Cookie', signedInAs(ROLES.HR))

    // Paging is not part of what a printed list is: everything matching goes on
    // the paper, whatever the screen was showing.
    const [filters] = db.allEmployees.mock.calls[0] ?? []
    expect(filters).not.toHaveProperty('page')
    expect(filters).not.toHaveProperty('pageSize')
  })

  it('answers 404 for a document type that does not exist', async () => {
    db.findDocumentType.mockResolvedValue(null)

    const response = await request(app).get(PRINT_URL).set('Cookie', signedInAs(ROLES.HR))

    expect(response.status).toBe(404)
    expect(db.allEmployees).not.toHaveBeenCalled()
  })

  it('refuses an unauthenticated request', async () => {
    const response = await request(app).get(PRINT_URL)

    expect(response.status).toBe(401)
    expect(db.allEmployees).not.toHaveBeenCalled()
  })
})
