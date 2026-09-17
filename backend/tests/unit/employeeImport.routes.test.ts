import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROLES, toXlsx, type Role } from '@asps-dms/shared'

/**
 * Importing employees from the screen, over HTTP with the database mocked.
 *
 * The file is a real .xlsx, built by the writer in shared/ and read by the
 * reader in the backend - the same path a file HR saves from Excel takes. What
 * is asserted is the boundary the office cares about: the preview writes
 * nothing, the commit creates exactly the rows the preview said it would and
 * skips the rest, one refused row does not stop the others, and the same file
 * twice creates nothing the second time.
 */

const db = vi.hoisted(() => ({
  findByTokenHash: vi.fn(),
  touchSession: vi.fn(),
  allEmployeeCodes: vi.fn(),
  createEmployee: vi.fn(),
  findEmployee: vi.fn(),
  listActiveTypes: vi.fn(),
  createChecklist: vi.fn(),
  insertAudit: vi.fn(),
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

vi.mock('../../src/repositories/employee.repository.js', () => ({
  allEmployeeCodes: db.allEmployeeCodes,
  create: db.createEmployee,
  findById: db.findEmployee,
  list: vi.fn(),
  listAll: vi.fn(),
  listFacets: vi.fn(),
  findPhoto: vi.fn(),
}))

vi.mock('../../src/repositories/documentType.repository.js', () => ({
  listActive: db.listActiveTypes,
  listAll: vi.fn(),
  findById: vi.fn(),
}))

vi.mock('../../src/repositories/employeeDocument.repository.js', () => ({
  createChecklist: db.createChecklist,
  listForEmployee: vi.fn(),
  listDocumentTypeIdsForEmployee: vi.fn(),
  findStoredFile: vi.fn(),
}))

vi.mock('../../src/repositories/audit.repository.js', () => ({ insert: db.insertAudit }))

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
    username: 'hr1',
    fullName: 'Priya Sharma',
    role,
    isActive: true,
    mustChangePassword: false,
  })
  return [`${COOKIE_NAME}=${TOKEN}`]
}

/** A sheet as HR would save one: any headings, code / name / date by position. */
function sheet(rows: readonly (readonly string[])[]): Buffer {
  type Cells = { a: string; b: string; c: string; d: string }
  const records: Cells[] = rows.map(([a = '', b = '', c = '', d = '']) => ({ a, b, c, d }))
  return Buffer.from(
    toXlsx(
      records,
      [
        { header: 'Emp No', value: (r) => r.a },
        { header: 'Worker Name', value: (r) => r.b },
        { header: 'DOJ', value: (r) => r.c },
        { header: 'Ignored', value: (r) => r.d },
      ],
      'Sheet1',
      new Date(2026, 8, 17),
    ),
  )
}

/** Thirty-ish rows worth of trouble in five: two good, one padded, one bad date, one duplicate. */
const FILE = sheet([
  ['00005696', 'Ravi Kumar Gaur', '07/09/2026', 'Cutting'],
  ['5697', 'Anita Devi', '07/09/2026', ''],
  ['00005698', 'Bad Date', '31/31/2026', ''],
  ['00000068', 'MD RAJJAK ALAM', '11/04/2022', ''],
  ['00005699', '', '07/09/2026', ''],
])

const PREVIEW_URL = '/api/employees/import/preview'
const COMMIT_URL = '/api/employees/import'

beforeEach(() => {
  vi.clearAllMocks()
  db.touchSession.mockResolvedValue(undefined)
  db.insertAudit.mockResolvedValue(undefined)
  db.allEmployeeCodes.mockResolvedValue(new Set(['00000068']))
  db.listActiveTypes.mockResolvedValue([])
  db.createChecklist.mockResolvedValue(0)
  let nextId = 100
  db.createEmployee.mockImplementation(async (input: { employeeCode: string }) => ({
    employeeId: (nextId += 1),
    employeeCode: input.employeeCode,
  }))
  db.findEmployee.mockImplementation(async (employeeId: number) => ({
    employeeId,
    employeeCode: 'X',
    employeeName: 'X',
    joiningDate: '2026-09-07',
    department: null,
    designation: null,
    isActive: true,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    counts: { total: 0, completed: 0, pending: 0, overdue: 0, signatureReviewRequired: 0 },
    hasSignature: false,
    signatureUpdatedAt: null,
  }))
})

describe('previewing an import', () => {
  it('judges every row and writes nothing', async () => {
    const response = await request(app)
      .post(PREVIEW_URL)
      .set('Cookie', signedInAs(ROLES.HR))
      .field('dateFormat', 'dmy')
      .attach('file', FILE, 'staff.xlsx')

    expect(response.status).toBe(200)
    const { preview } = response.body

    // What was read, so a file with no header row is obvious on screen.
    expect(preview.header).toEqual(['Emp No', 'Worker Name', 'DOJ'])
    expect(preview.firstRow).toEqual(['00005696', 'Ravi Kumar Gaur', '07/09/2026'])
    // The first date, as typed and as understood.
    expect(preview.firstDate).toEqual({ text: '07/09/2026', iso: '2026-09-07' })
    expect(preview.totals).toEqual({ read: 5, create: 2, skip: 1, fail: 2, padded: 1 })

    const byLine = Object.fromEntries(preview.rows.map((row: { line: number }) => [row.line, row]))
    expect(byLine[2]).toMatchObject({ outcome: 'create', employeeCode: '00005696' })
    expect(byLine[3]).toMatchObject({ outcome: 'create', employeeCode: '00005697', paddedFrom: '5697' })
    expect(byLine[4]).toMatchObject({ outcome: 'fail' })
    expect(byLine[4].errors.join(' ')).toContain('not a date')
    expect(byLine[5]).toMatchObject({ outcome: 'skip', duplicate: 'in the database' })
    expect(byLine[6]).toMatchObject({ outcome: 'fail' })
    // The original cells travel with every row, for the rejected download.
    expect(byLine[4].cells).toEqual(['00005698', 'Bad Date', '31/31/2026'])

    // Nothing was created, and nothing was even asked of the checklist.
    expect(db.createEmployee).not.toHaveBeenCalled()
    expect(db.createChecklist).not.toHaveBeenCalled()
  })

  it('reads the date the other way round when asked, and says what it read', async () => {
    const response = await request(app)
      .post(PREVIEW_URL)
      .set('Cookie', signedInAs(ROLES.HR))
      .field('dateFormat', 'mdy')
      .attach('file', FILE, 'staff.xlsx')

    // 07/09/2026 as month/day: the 9th of July.
    expect(response.body.preview.firstDate).toEqual({ text: '07/09/2026', iso: '2026-07-09' })
    expect(response.body.preview.dateFormat).toBe('mdy')
  })

  it('defaults to day/month/year, as the Add Employee form asks', async () => {
    const response = await request(app)
      .post(PREVIEW_URL)
      .set('Cookie', signedInAs(ROLES.HR))
      .attach('file', FILE, 'staff.xlsx')

    expect(response.body.preview.dateFormat).toBe('dmy')
    expect(response.body.preview.firstDate.iso).toBe('2026-09-07')
  })

  it('refuses a file that is not an .xlsx, by its bytes', async () => {
    const response = await request(app)
      .post(PREVIEW_URL)
      .set('Cookie', signedInAs(ROLES.HR))
      .attach('file', Buffer.from('employee_code,full_name\n1,2\n'), 'staff.xlsx')

    expect(response.status).toBe(400)
    expect(response.body.error.message).toContain('.xlsx')
  })

  it('refuses a Viewer, who cannot create an employee either', async () => {
    const response = await request(app)
      .post(PREVIEW_URL)
      .set('Cookie', signedInAs(ROLES.VIEWER))
      .attach('file', FILE, 'staff.xlsx')

    expect(response.status).toBe(403)
    expect(db.allEmployeeCodes).not.toHaveBeenCalled()
  })
})

describe('committing an import', () => {
  it('creates the valid rows, skips the rest, and reports each bucket', async () => {
    const response = await request(app)
      .post(COMMIT_URL)
      .set('Cookie', signedInAs(ROLES.HR))
      .field('dateFormat', 'dmy')
      .attach('file', FILE, 'staff.xlsx')

    expect(response.status).toBe(201)
    expect(response.body.result).toMatchObject({ created: 2, skipped: 1, refused: [] })
    expect(response.body.result.failed.map((row: { line: number }) => row.line)).toEqual([4, 6])

    // Exactly the two valid rows, with the zeros restored, through the same
    // create the form uses - and never the duplicate or the failures.
    const codes = db.createEmployee.mock.calls.map(
      (call: unknown[]) => (call[0] as { employeeCode: string }).employeeCode,
    )
    expect(codes).toEqual(['00005696', '00005697'])
    // Each one gets its checklist built, exactly as a typed employee does.
    expect(db.createChecklist).toHaveBeenCalledTimes(2)
    // In the name of the person who pressed the button.
    expect(db.createEmployee.mock.calls[0]?.[1]).toBe(7)
  })

  it('goes on past a row the database refuses, and says which one', async () => {
    db.createEmployee.mockImplementationOnce(async () => {
      const error = Object.assign(new Error('Violation of UNIQUE KEY constraint'), { number: 2627 })
      throw error
    })

    const response = await request(app)
      .post(COMMIT_URL)
      .set('Cookie', signedInAs(ROLES.HR))
      .attach('file', FILE, 'staff.xlsx')

    expect(response.status).toBe(201)
    expect(response.body.result.created).toBe(1)
    expect(response.body.result.refused).toHaveLength(1)
    expect(response.body.result.refused[0]).toMatchObject({
      line: 2,
      employeeCode: '00005696',
      cells: ['00005696', 'Ravi Kumar Gaur', '07/09/2026'],
    })
    expect(response.body.result.refused[0].reason).toContain('already in use')
  })

  it('creates nothing the second time the same file is imported', async () => {
    // After the first run, the two it created are in the database.
    db.allEmployeeCodes.mockResolvedValue(new Set(['00000068', '00005696', '00005697']))

    const response = await request(app)
      .post(COMMIT_URL)
      .set('Cookie', signedInAs(ROLES.HR))
      .attach('file', FILE, 'staff.xlsx')

    expect(response.status).toBe(201)
    expect(response.body.result).toMatchObject({ created: 0, skipped: 3 })
    expect(db.createEmployee).not.toHaveBeenCalled()
  })

  it('refuses a Viewer', async () => {
    const response = await request(app)
      .post(COMMIT_URL)
      .set('Cookie', signedInAs(ROLES.VIEWER))
      .attach('file', FILE, 'staff.xlsx')

    expect(response.status).toBe(403)
    expect(db.createEmployee).not.toHaveBeenCalled()
  })

  it('reads /employees/import as a route, not as an employee id', async () => {
    const response = await request(app)
      .post(COMMIT_URL)
      .set('Cookie', signedInAs(ROLES.HR))

    // No file attached: the import's own complaint, not a 404 for employee 'import'.
    expect(response.status).toBe(400)
    expect(response.body.error.message).toContain('spreadsheet')
  })
})
