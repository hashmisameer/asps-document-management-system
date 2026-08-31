import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUDIT_ACTIONS,
  DEADLINE_STATE,
  DOCUMENT_STATUS,
  ROLES,
  SIGNATURE_STATUS,
  todayDateOnly,
  type AuthUser,
  type DocumentType,
  type EmployeeProfile,
} from '@asps-dms/shared'
import type { EmployeeDocumentRecord } from '../../src/repositories/employeeDocument.repository.js'

/**
 * Employee creation and its checklist.
 *
 * The assertion that matters most here is that an employee never exists
 * without a checklist: a record with no rows reports nothing outstanding, which
 * looks exactly like a fully compliant employee and is the most dangerous wrong
 * answer this system can give.
 */

const db = vi.hoisted(() => ({
  createEmployee: vi.fn(),
  updateEmployee: vi.fn(),
  setActive: vi.fn(),
  findById: vi.fn(),
  listActiveTypes: vi.fn(),
  createChecklist: vi.fn(),
  listForEmployee: vi.fn(),
  insertAudit: vi.fn(),
}))

vi.mock('../../src/database/pool.js', () => ({
  // The service's only use of the pool is the transaction boundary; running
  // the work function directly is what lets the rest be asserted.
  withTransaction: async <T>(work: (tx: unknown) => Promise<T>) => work({}),
}))

vi.mock('../../src/repositories/employee.repository.js', () => ({
  create: db.createEmployee,
  update: db.updateEmployee,
  setActive: db.setActive,
  findById: db.findById,
  list: vi.fn(),
  listFacets: vi.fn(),
}))

vi.mock('../../src/repositories/documentType.repository.js', () => ({
  listActive: db.listActiveTypes,
  listAll: vi.fn(),
  findById: vi.fn(),
}))

vi.mock('../../src/repositories/employeeDocument.repository.js', () => ({
  createChecklist: db.createChecklist,
  listForEmployee: db.listForEmployee,
  listDocumentTypeIdsForEmployee: vi.fn(),
}))

vi.mock('../../src/repositories/audit.repository.js', () => ({ insert: db.insertAudit }))

const employeeService = await import('../../src/services/employee.service.js')

const actor: AuthUser = {
  userId: 3,
  username: 'hr1',
  fullName: 'Priya Sharma',
  role: ROLES.HR,
  mustChangePassword: false,
}

const context = { ipAddress: '10.0.0.5', userAgent: 'test' }

function documentType(overrides: Partial<DocumentType> = {}): DocumentType {
  return {
    documentTypeId: 1,
    documentName: 'PAN Card',
    documentCode: 'PAN_CARD',
    isMandatory: true,
    isActive: true,
    requiresSignature: false,
    deadlineValue: 10,
    deadlineUnit: 'DAY',
    sortOrder: 10,
    requiredFields: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function profile(overrides: Partial<EmployeeProfile> = {}): EmployeeProfile {
  return {
    employeeId: 42,
    employeeCode: 'EMP001',
    employeeName: 'Ravi Kumar',
    joiningDate: '2026-09-01',
    department: 'Accounts',
    designation: null,
    phoneNumber: null,
    dateOfBirth: null,
    postAppliedFor: null,
    categoryOfWorkmen: null,
    aadhaarNumber: null,
    panNumber: null,
    uanNumber: null,
    esiNumber: null,
    appointmentLetterDate: null,
    isActive: true,
    createdAt: '2026-09-01T04:00:00.000Z',
    updatedAt: '2026-09-01T04:00:00.000Z',
    counts: { total: 1, completed: 0, pending: 1, overdue: 0, signatureReviewRequired: 0 },
    hasSignature: false,
    signatureUpdatedAt: null,
    ...overrides,
  }
}

function checklistRecord(overrides: Partial<EmployeeDocumentRecord> = {}): EmployeeDocumentRecord {
  return {
    documentId: 5,
    employeeId: 42,
    employeeCode: 'EMP001',
    employeeName: 'Ravi Kumar',
    documentTypeId: 1,
    documentName: 'PAN Card',
    isMandatory: true,
    requiresSignature: false,
    originalFileName: null,
    fileSizeBytes: null,
    mimeType: null,
    pageCount: null,
    hasProcessedFile: false,
    status: DOCUMENT_STATUS.PENDING,
    signatureStatus: SIGNATURE_STATUS.NOT_REQUIRED,
    dueDate: null,
    uploadedByName: null,
    uploadedAt: null,
    verifiedByName: null,
    verifiedAt: null,
    rejectionReason: null,
    identityCheck: null,
    createdAt: '2026-09-01T04:00:00.000Z',
    updatedAt: '2026-09-01T04:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  db.insertAudit.mockResolvedValue(undefined)
  db.createEmployee.mockResolvedValue({ employeeId: 42, employeeCode: 'EMP001' })
  db.createChecklist.mockResolvedValue(1)
  db.findById.mockResolvedValue(profile())
  db.updateEmployee.mockResolvedValue(true)
  db.setActive.mockResolvedValue(true)
})

describe('create', () => {
  const input = {
    employeeName: 'Ravi Kumar',
    joiningDate: '2026-09-01',
    department: 'Accounts',
    designation: null,
  }

  it('materialises the checklist with due dates from the shared deadline rules', async () => {
    db.listActiveTypes.mockResolvedValue([
      documentType(),
      documentType({ documentTypeId: 2, deadlineValue: 1, deadlineUnit: 'MONTH' }),
      documentType({ documentTypeId: 3, deadlineValue: null, deadlineUnit: null }),
    ])

    await employeeService.create(input, actor, context)

    // Section 20's worked example: 2026-09-01 + 10 DAY -> 2026-09-11.
    expect(db.createChecklist).toHaveBeenCalledWith(
      42,
      [
        { documentTypeId: 1, dueDate: '2026-09-11' },
        { documentTypeId: 2, dueDate: '2026-10-01' },
        { documentTypeId: 3, dueDate: null },
      ],
      expect.anything(),
    )
  })

  it('reads the document types inside the same transaction as the insert', async () => {
    db.listActiveTypes.mockResolvedValue([documentType()])

    await employeeService.create(input, actor, context)

    const transaction = db.createEmployee.mock.calls[0]?.[2]
    expect(transaction).toBeDefined()
    expect(db.listActiveTypes).toHaveBeenCalledWith(transaction)
    expect(db.createChecklist.mock.calls[0]?.[2]).toBe(transaction)
  })

  it('records who created the employee, with the generated code', async () => {
    db.listActiveTypes.mockResolvedValue([documentType()])

    await employeeService.create(input, actor, context)

    expect(db.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 3,
        action: AUDIT_ACTIONS.EMPLOYEE_CREATED,
        entityId: '42',
      }),
    )
    const metadata = JSON.parse(db.insertAudit.mock.calls[0]?.[0].metadataJson ?? '{}') as {
      employeeCode: string
      checklistRows: number
    }
    expect(metadata.employeeCode).toBe('EMP001')
    expect(metadata.checklistRows).toBe(1)
  })

  it('creates the employee even when no document types are configured yet', async () => {
    db.listActiveTypes.mockResolvedValue([])
    db.createChecklist.mockResolvedValue(0)

    await expect(employeeService.create(input, actor, context)).resolves.toBeDefined()
    expect(db.createChecklist).toHaveBeenCalledWith(42, [], expect.anything())
  })

  it('turns a duplicate employee code into a 409 rather than a 500', async () => {
    db.listActiveTypes.mockResolvedValue([documentType()])
    db.createEmployee.mockRejectedValue(Object.assign(new Error('Violation'), { number: 2627 }))

    await expect(employeeService.create(input, actor, context)).rejects.toMatchObject({
      statusCode: 409,
    })
    expect(db.insertAudit).not.toHaveBeenCalled()
  })
})

describe('update', () => {
  it('audits what changed, and what it changed from', async () => {
    await employeeService.update(42, { department: 'Finance' }, actor, context)

    const metadata = JSON.parse(db.insertAudit.mock.calls[0]?.[0].metadataJson ?? '{}') as {
      changes: Record<string, { from: string; to: string }>
    }
    expect(metadata.changes).toEqual({ department: { from: 'Accounts', to: 'Finance' } })
  })

  it('does not report a field that was sent unchanged as a change', async () => {
    await employeeService.update(42, { employeeName: 'Ravi Kumar' }, actor, context)

    const metadata = JSON.parse(db.insertAudit.mock.calls[0]?.[0].metadataJson ?? '{}') as {
      changes: Record<string, unknown>
    }
    expect(metadata.changes).toEqual({})
  })

  it('rejects an unknown employee before writing anything', async () => {
    db.findById.mockResolvedValue(null)

    await expect(
      employeeService.update(999, { employeeName: 'Nobody' }, actor, context),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(db.updateEmployee).not.toHaveBeenCalled()
  })
})

describe('setArchived', () => {
  it('archives an active employee and records it', async () => {
    await employeeService.setArchived(42, true, actor, context)

    expect(db.setActive).toHaveBeenCalledWith(42, false)
    expect(db.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.EMPLOYEE_ARCHIVED }),
    )
  })

  it('is a no-op when the employee is already archived', async () => {
    db.findById.mockResolvedValue(profile({ isActive: false }))

    await employeeService.setArchived(42, true, actor, context)

    // A repeated click is not an event worth an audit entry.
    expect(db.setActive).not.toHaveBeenCalled()
    expect(db.insertAudit).not.toHaveBeenCalled()
  })

  it('restores an archived employee under its own audit action', async () => {
    db.findById.mockResolvedValue(profile({ isActive: false }))

    await employeeService.setArchived(42, false, actor, context)

    expect(db.setActive).toHaveBeenCalledWith(42, true)
    expect(db.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.EMPLOYEE_RESTORED }),
    )
  })
})

describe('listDocuments', () => {
  it('derives overdue from the due date at read time', async () => {
    db.listForEmployee.mockResolvedValue([
      checklistRecord({ dueDate: '2020-01-01' }),
      checklistRecord({
        documentId: 6,
        dueDate: '2020-01-01',
        status: DOCUMENT_STATUS.VERIFIED,
      }),
      checklistRecord({ documentId: 7, dueDate: null }),
    ])

    const documents = await employeeService.listDocuments(42)

    expect(documents[0]?.deadlineState).toBe(DEADLINE_STATE.OVERDUE)
    expect(documents[0]?.daysRemaining).toBeLessThan(0)
    // A document that is in is not overdue, however old its deadline is.
    expect(documents[1]?.deadlineState).toBe(DEADLINE_STATE.COMPLETED)
    expect(documents[2]?.deadlineState).toBe(DEADLINE_STATE.NOT_APPLICABLE)
  })

  it('calls a document due today due today, not overdue', async () => {
    db.listForEmployee.mockResolvedValue([checklistRecord({ dueDate: todayDateOnly() })])

    const documents = await employeeService.listDocuments(42)

    expect(documents[0]?.deadlineState).toBe(DEADLINE_STATE.DUE_TODAY)
    expect(documents[0]?.daysRemaining).toBe(0)
  })

  it('404s for an employee that does not exist rather than returning an empty list', async () => {
    db.findById.mockResolvedValue(null)

    await expect(employeeService.listDocuments(999)).rejects.toMatchObject({ statusCode: 404 })
  })
})
