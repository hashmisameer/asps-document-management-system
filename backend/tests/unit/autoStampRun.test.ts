import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUDIT_ACTIONS,
  DOCUMENT_STATUS,
  ROLES,
  SIGNATURE_STATUS,
  STAMP_OUTCOMES,
  type AuthUser,
  type DocumentTypePlacement,
} from '@asps-dms/shared'

/**
 * Stamping on upload: the runner, with everything it reads and writes mocked.
 *
 * The rules are pinned in autoStamp.test.ts. What is pinned here is the
 * plumbing that makes them safe: report mode records and paints nothing;
 * stamp mode paints exactly the boxes the decision named and nothing else;
 * the document never stays in PendingDetection; the MMC folder is looked in
 * first; and a run that blows up is recorded as a failure and sent to HR.
 */

const mocks = vi.hoisted(() => ({
  autoStamp: 'report' as 'report' | 'stamp',
  findDocument: vi.fn(),
  findStoredFile: vi.fn(),
  setSignatureStatus: vi.fn(),
  findEmployee: vi.fn(),
  listForType: vi.fn(),
  findActiveSignature: vi.fn(),
  findActiveUserSignature: vi.fn(),
  insertDecision: vi.fn(),
  insertAudit: vi.fn(),
  attachQuietly: vi.fn(),
  checkDocument: vi.fn(),
  applyPlacements: vi.fn(),
  readSignatureImages: vi.fn(),
  readPhotoForStamp: vi.fn(),
}))

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>()
  return {
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'AUTO_STAMP' ? mocks.autoStamp : (target as Record<string | symbol, unknown>)[key],
    }),
  }
})
vi.mock('../../src/repositories/employeeDocument.repository.js', () => ({
  findById: mocks.findDocument,
  findStoredFile: mocks.findStoredFile,
  setSignatureStatus: mocks.setSignatureStatus,
}))
vi.mock('../../src/repositories/employee.repository.js', () => ({
  findById: mocks.findEmployee,
}))
vi.mock('../../src/repositories/documentTypePlacement.repository.js', () => ({
  listForType: mocks.listForType,
}))
vi.mock('../../src/repositories/employeeSignature.repository.js', () => ({
  findActiveByEmployee: mocks.findActiveSignature,
}))
vi.mock('../../src/repositories/userSignature.repository.js', () => ({
  findActiveByUser: mocks.findActiveUserSignature,
}))
vi.mock('../../src/repositories/stampDecision.repository.js', () => ({
  insert: mocks.insertDecision,
}))
vi.mock('../../src/repositories/audit.repository.js', () => ({ insert: mocks.insertAudit }))
vi.mock('../../src/services/mmcImages.service.js', () => ({
  attachQuietly: mocks.attachQuietly,
}))
vi.mock('../../src/services/stampCheck.service.js', () => ({
  checkDocument: mocks.checkDocument,
}))
vi.mock('../../src/services/signature.service.js', () => ({
  applyPlacements: mocks.applyPlacements,
  readSignatureImages: mocks.readSignatureImages,
  readPhotoForStamp: mocks.readPhotoForStamp,
}))

const { run, runBacklog } = await import('../../src/services/autoStampRun.service.js')

const actor: AuthUser = {
  userId: 7,
  username: 'hr1',
  fullName: 'Priya Sharma',
  role: ROLES.HR,
  mustChangePassword: false,
}
const context = { ipAddress: '10.0.0.5', userAgent: 'test' }

const A4 = { pageCount: 1, widthPt: 595, heightPt: 842 }

function templateRow(
  signerRole: 'Employee' | 'Authoriser' | 'Photo',
  x = 0.6,
): DocumentTypePlacement {
  return {
    documentTypePlacementId: 1,
    documentTypeId: 1,
    signerRole,
    pageNumber: 1,
    x,
    y: 0.8,
    width: 0.25,
    height: 0.08,
    pageRotation: 0,
    pageWidthPt: 595,
    pageHeightPt: 842,
    variant: A4,
    sampleDocumentId: null,
    createdByName: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  }
}

const rows = [templateRow('Employee', 0.1), templateRow('Authoriser', 0.6)]

function document(overrides: Record<string, unknown> = {}) {
  return {
    documentId: 5,
    employeeId: 42,
    employeeCode: 'EMP001',
    employeeName: 'Ravi Kumar',
    documentTypeId: 1,
    documentName: 'Appointment Letter',
    documentCode: 'APPOINTMENT_LETTER',
    isMandatory: true,
    requiresSignature: true,
    originalFileName: 'letter.pdf',
    fileSizeBytes: 2048,
    mimeType: 'application/pdf',
    pageCount: 1,
    hasProcessedFile: false,
    status: DOCUMENT_STATUS.UPLOADED,
    signatureStatus: SIGNATURE_STATUS.PENDING_DETECTION,
    identityCheck: { status: 'Passed' },
    dueDate: null,
    employeeHasLeft: false,
    ...overrides,
  }
}

/** A stamp-check that matched the A4 variant and found every box empty. */
function checkedEmpty() {
  return {
    documentId: 5,
    documentCode: 'APPOINTMENT_LETTER',
    documentName: 'Appointment Letter',
    signatureStatus: 'PendingDetection',
    hasProcessedFile: false,
    outcome: 'checked',
    measured: A4,
    variant: A4,
    boxes: rows.map((row, index) => ({
      label: String(index),
      signerRole: row.signerRole,
      pageNumber: 1,
      rect: { x: row.x, y: row.y, width: row.width, height: row.height },
      verdict: 'empty',
      decidedBy: 'none',
      pageKind: 'digital',
      overlap: { images: 0, coverage: 0 },
      reason: 'no image on the box',
    })),
  }
}

const employeeSignature = { relativePath: 'signatures/42/sig.png', mimeType: 'image/png' }
const userSignature = { relativePath: 'user-signatures/7/sig.png', mimeType: 'image/png' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.autoStamp = 'report'
  mocks.findDocument.mockResolvedValue(document())
  mocks.findStoredFile.mockResolvedValue({
    documentId: 5,
    employeeId: 42,
    storedFileName: 'x.pdf',
    originalFilePath: 'documents/42/original.pdf',
    processedFilePath: null,
    originalFileName: 'letter.pdf',
    mimeType: 'application/pdf',
  })
  mocks.setSignatureStatus.mockResolvedValue(true)
  mocks.findEmployee.mockResolvedValue({ employeeId: 42, employeeCode: 'EMP001' })
  mocks.listForType.mockResolvedValue(rows)
  mocks.findActiveSignature.mockResolvedValue(employeeSignature)
  mocks.findActiveUserSignature.mockResolvedValue(userSignature)
  mocks.readPhotoForStamp.mockResolvedValue(null)
  mocks.checkDocument.mockResolvedValue(checkedEmpty())
  mocks.insertDecision.mockResolvedValue(1)
  mocks.insertAudit.mockResolvedValue(undefined)
  mocks.attachQuietly.mockResolvedValue(undefined)
  mocks.readSignatureImages.mockResolvedValue({ Employee: {}, Authoriser: {} })
  mocks.applyPlacements.mockResolvedValue(undefined)
})

describe('report mode', () => {
  it('records what it would have stamped, paints nothing, and sends the document to HR', async () => {
    const result = await run(5, actor, context)

    expect(result?.mode).toBe('Report')
    expect(result?.decision.outcome).toBe(STAMP_OUTCOMES.STAMPED)
    expect(result?.stamped).toBe(0)
    expect(result?.status).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)

    expect(mocks.applyPlacements).not.toHaveBeenCalled()
    expect(mocks.insertDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 5,
        mode: 'Report',
        outcome: STAMP_OUTCOMES.STAMPED,
        variantKey: '1p-portrait-1.42',
        stampedCount: 2,
        skippedCount: 0,
        decidedBy: 7,
      }),
    )
    expect(mocks.setSignatureStatus).toHaveBeenCalledWith(
      5,
      SIGNATURE_STATUS.PENDING_DETECTION,
      SIGNATURE_STATUS.REVIEW_REQUIRED,
    )
  })

  it('writes the decision to the audit trail as well', async () => {
    await run(5, actor, context)

    const entry = mocks.insertAudit.mock.calls[0]?.[0] as { action: string; metadataJson: string }
    expect(entry.action).toBe(AUDIT_ACTIONS.AUTO_STAMP_DECIDED)
    expect(JSON.parse(entry.metadataJson)).toMatchObject({
      mode: 'Report',
      outcome: STAMP_OUTCOMES.STAMPED,
      toStamp: 2,
      leftAlone: 0,
    })
  })
})

describe('stamp mode', () => {
  beforeEach(() => {
    mocks.autoStamp = 'stamp'
  })

  it('stamps exactly the boxes the decision named, where the template put them', async () => {
    const result = await run(5, actor, context)

    expect(result?.stamped).toBe(2)
    expect(result?.status).toBe(SIGNATURE_STATUS.ADDED)
    expect(mocks.applyPlacements).toHaveBeenCalledTimes(1)

    const input = mocks.applyPlacements.mock.calls[0]?.[0] as {
      boxes: { signerRole: string; x: number; method: string; detectionMethod: string }[]
      nextStatus: string
      auditAction: string
      originalFilePath: string
    }
    expect(input.originalFilePath).toBe('documents/42/original.pdf')
    expect(input.nextStatus).toBe(SIGNATURE_STATUS.ADDED)
    expect(input.auditAction).toBe(AUDIT_ACTIONS.SIGNATURE_PLACED_FROM_TEMPLATE)
    expect(input.boxes.map((box) => [box.signerRole, box.x])).toEqual([
      ['Employee', 0.1],
      ['Authoriser', 0.6],
    ])
    expect(input.boxes.every((box) => box.method === 'Automatic')).toBe(true)
    expect(input.boxes.every((box) => box.detectionMethod === 'Template')).toBe(true)
    // The status was set by the stamp itself; nothing moved it separately.
    expect(mocks.setSignatureStatus).not.toHaveBeenCalled()
  })

  it('reads only the images the stamped boxes need', async () => {
    mocks.findActiveUserSignature.mockResolvedValue(null)

    const result = await run(5, actor, context)

    expect(result?.decision.outcome).toBe(STAMP_OUTCOMES.PARTIAL)
    expect(mocks.readSignatureImages).toHaveBeenCalledWith({
      employee: employeeSignature,
      authoriser: null,
      photo: null,
    })
    const input = mocks.applyPlacements.mock.calls[0]?.[0] as {
      boxes: { signerRole: string }[]
      nextStatus: string
    }
    expect(input.boxes.map((box) => box.signerRole)).toEqual(['Employee'])
    // Something is still missing, so HR sees it even though the employee box went on.
    expect(input.nextStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
  })

  it('paints nothing and sends the document to HR when every box was left alone', async () => {
    mocks.findActiveSignature.mockResolvedValue(null)
    mocks.findActiveUserSignature.mockResolvedValue(null)

    const result = await run(5, actor, context)

    expect(result?.decision.outcome).toBe(STAMP_OUTCOMES.NOTHING)
    expect(mocks.applyPlacements).not.toHaveBeenCalled()
    expect(mocks.setSignatureStatus).toHaveBeenCalledWith(
      5,
      SIGNATURE_STATUS.PENDING_DETECTION,
      SIGNATURE_STATUS.REVIEW_REQUIRED,
    )
  })

  it('stamps nothing on a document whose identity check failed', async () => {
    mocks.findDocument.mockResolvedValue(document({ identityCheck: { status: 'Failed' } }))

    const result = await run(5, actor, context)

    expect(result?.decision.outcome).toBe(STAMP_OUTCOMES.IDENTITY_FAILED)
    expect(mocks.applyPlacements).not.toHaveBeenCalled()
    expect(mocks.insertDecision).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: STAMP_OUTCOMES.IDENTITY_FAILED }),
    )
  })
})

describe('what it reads first', () => {
  it('looks in the MMC folder before deciding, so a signature that has since appeared is used', async () => {
    await run(5, actor, context)

    expect(mocks.attachQuietly).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 42 }),
      actor,
      context,
    )
    const attachOrder = mocks.attachQuietly.mock.invocationCallOrder[0] ?? Infinity
    const readOrder = mocks.findActiveSignature.mock.invocationCallOrder[0] ?? 0
    expect(attachOrder).toBeLessThan(readOrder)
  })

  it('does not run the stamp check for a type with no template, and says so', async () => {
    mocks.listForType.mockResolvedValue([])

    const result = await run(5, actor, context)

    expect(mocks.checkDocument).not.toHaveBeenCalled()
    expect(result?.decision.outcome).toBe(STAMP_OUTCOMES.NO_TEMPLATE)
    expect(result?.status).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
  })
})

describe('what it leaves alone', () => {
  it('a document that needs no signature', async () => {
    mocks.findDocument.mockResolvedValue(document({ requiresSignature: false }))
    expect(await run(5, actor, context)).toBeNull()
    expect(mocks.insertDecision).not.toHaveBeenCalled()
  })

  it('a document with no file', async () => {
    mocks.findDocument.mockResolvedValue(document({ originalFileName: null }))
    expect(await run(5, actor, context)).toBeNull()
  })

  it('a document already signed, or skipped', async () => {
    for (const signatureStatus of [SIGNATURE_STATUS.ADDED, SIGNATURE_STATUS.SKIPPED]) {
      mocks.findDocument.mockResolvedValue(document({ signatureStatus }))
      expect(await run(5, actor, context)).toBeNull()
    }
    expect(mocks.insertDecision).not.toHaveBeenCalled()
  })

  it('a document somebody else has moved meanwhile', async () => {
    mocks.setSignatureStatus.mockResolvedValue(false)

    const result = await run(5, actor, context)

    // Decided and recorded; the status is theirs to keep.
    expect(result?.status).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
    expect(mocks.insertDecision).toHaveBeenCalled()
  })
})

describe('when it goes wrong', () => {
  it('records a failed decision and sends the document to HR rather than leaving it stuck', async () => {
    mocks.checkDocument.mockRejectedValue(new Error('pdf.js could not open the file'))

    const result = await run(5, actor, context)

    expect(result).toBeNull()
    expect(mocks.applyPlacements).not.toHaveBeenCalled()
    expect(mocks.insertDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: STAMP_OUTCOMES.FAILED,
        summary: 'Not stamped: the check could not be run (pdf.js could not open the file).',
      }),
    )
    expect(mocks.setSignatureStatus).toHaveBeenCalledWith(
      5,
      SIGNATURE_STATUS.PENDING_DETECTION,
      SIGNATURE_STATUS.REVIEW_REQUIRED,
    )
  })

  it('never throws, even when recording the failure fails too', async () => {
    mocks.checkDocument.mockRejectedValue(new Error('boom'))
    mocks.insertDecision.mockRejectedValue(new Error('database gone'))

    await expect(run(5, actor, context)).resolves.toBeNull()
  })
})

describe('the backlog', () => {
  const fallback: AuthUser = { ...actor, userId: 1, username: 'admin', role: ROLES.ADMIN }
  const uploader: AuthUser = { ...actor, userId: 9, username: 'hr.original' }

  it('decides each document in the name of its uploader, and looks each uploader up once', async () => {
    const resolveUploader = vi.fn(async (userId: number) => (userId === 9 ? uploader : null))
    mocks.findDocument.mockImplementation(async (id: number) => document({ documentId: id }))

    const outcomes = await runBacklog(
      [
        { documentId: 5, documentName: 'Appointment Letter', uploadedBy: 9 },
        { documentId: 6, documentName: 'Bio Data Form', uploadedBy: 9 },
      ],
      { fallback, context, resolveUploader },
    )

    expect(outcomes.map((o) => [o.documentId, o.usedFallback])).toEqual([
      [5, false],
      [6, false],
    ])
    expect(resolveUploader).toHaveBeenCalledTimes(1)
    // The decision was recorded in the uploader's name, not the fallback's.
    expect(mocks.insertDecision).toHaveBeenCalledWith(expect.objectContaining({ decidedBy: 9 }))
    expect(mocks.insertDecision).not.toHaveBeenCalledWith(expect.objectContaining({ decidedBy: 1 }))
  })

  it('falls back when the uploader is gone, and says so', async () => {
    const outcomes = await runBacklog(
      [
        { documentId: 5, documentName: 'Appointment Letter', uploadedBy: 404 },
        { documentId: 6, documentName: 'Bio Data Form', uploadedBy: null },
      ],
      { fallback, context, resolveUploader: async () => null },
    )

    expect(outcomes.every((o) => o.usedFallback)).toBe(true)
    expect(mocks.insertDecision).toHaveBeenCalledTimes(2)
    expect(mocks.insertDecision).toHaveBeenCalledWith(expect.objectContaining({ decidedBy: 1 }))
  })

  it('reports a document the runner left alone, and carries on', async () => {
    const seen: number[] = []
    mocks.findDocument
      .mockResolvedValueOnce(document({ signatureStatus: SIGNATURE_STATUS.ADDED }))
      .mockResolvedValueOnce(document({ documentId: 6 }))

    const outcomes = await runBacklog(
      [
        { documentId: 5, documentName: 'Appointment Letter', uploadedBy: null },
        { documentId: 6, documentName: 'Bio Data Form', uploadedBy: null },
      ],
      {
        fallback,
        context,
        resolveUploader: async () => null,
        onEach: (o) => seen.push(o.documentId),
      },
    )

    expect(outcomes[0]?.result).toBeNull()
    expect(outcomes[1]?.result?.status).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
    expect(seen).toEqual([5, 6])
  })
})
