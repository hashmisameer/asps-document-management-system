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
  autoStampTypes: new Set<string>(['APPOINTMENT_LETTER']),
  findDocument: vi.fn(),
  findLatestDecision: vi.fn(),
  listPlacements: vi.fn(),
  findUser: vi.fn(),
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
        key === 'AUTO_STAMP'
          ? mocks.autoStamp
          : key === 'AUTO_STAMP_TYPES'
            ? mocks.autoStampTypes
            : (target as Record<string | symbol, unknown>)[key],
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
  findLatestForDocument: mocks.findLatestDecision,
}))
vi.mock('../../src/repositories/audit.repository.js', () => ({ insert: mocks.insertAudit }))
vi.mock('../../src/repositories/signaturePlacement.repository.js', () => ({
  listForDocument: mocks.listPlacements,
}))
vi.mock('../../src/repositories/user.repository.js', () => ({
  findById: mocks.findUser,
  toAuthUser: (record: { userId: number; username: string; fullName: string; role: string }) => ({
    userId: record.userId,
    username: record.username,
    fullName: record.fullName,
    role: record.role,
    mustChangePassword: false,
  }),
}))
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

const { run, runOne, runBacklog, redecideForEmployee, redecideType } =
  await import('../../src/services/autoStampRun.service.js')

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
    templatesInShape: 1,
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
  mocks.autoStampTypes = new Set(['APPOINTMENT_LETTER'])
  mocks.findDocument.mockResolvedValue(document())
  mocks.findLatestDecision.mockResolvedValue(null)
  mocks.listPlacements.mockResolvedValue([])
  mocks.findUser.mockResolvedValue(null)
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
        variantKey: '1p-595x842',
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

describe('the auto-stamp list', () => {
  it('records a type not in the list as such, reads nothing, and sends the document to HR', async () => {
    mocks.autoStamp = 'stamp'
    mocks.findDocument.mockResolvedValue(
      document({ documentCode: 'PF_FORM', documentName: 'PF Form' }),
    )

    const result = await run(5, actor, context)

    expect(result?.decision.outcome).toBe(STAMP_OUTCOMES.NOT_IN_LIST)
    expect(result?.stamped).toBe(0)
    expect(result?.status).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)

    // Nothing was read that a decision would need: not the file, not the
    // template, not the images - and nothing was painted.
    expect(mocks.findStoredFile).not.toHaveBeenCalled()
    expect(mocks.listForType).not.toHaveBeenCalled()
    expect(mocks.checkDocument).not.toHaveBeenCalled()
    expect(mocks.applyPlacements).not.toHaveBeenCalled()

    expect(mocks.insertDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: STAMP_OUTCOMES.NOT_IN_LIST,
        stampedCount: 0,
        skippedCount: 0,
        summary: 'Not stamped: PF Form is not in the auto-stamp list.',
      }),
    )
    expect(mocks.setSignatureStatus).toHaveBeenCalledWith(
      5,
      SIGNATURE_STATUS.PENDING_DETECTION,
      SIGNATURE_STATUS.REVIEW_REQUIRED,
    )
  })

  it('still looks in the MMC folder first, whatever the type', async () => {
    mocks.findDocument.mockResolvedValue(document({ documentCode: 'PF_FORM' }))
    await run(5, actor, context)
    expect(mocks.attachQuietly).toHaveBeenCalledTimes(1)
  })

  it('stamps nothing at all when the list is empty, even in stamp mode', async () => {
    mocks.autoStamp = 'stamp'
    mocks.autoStampTypes = new Set()

    const result = await run(5, actor, context)

    expect(result?.decision.outcome).toBe(STAMP_OUTCOMES.NOT_IN_LIST)
    expect(mocks.applyPlacements).not.toHaveBeenCalled()
  })

  it('does not record the same "not in the list" twice for one document', async () => {
    // The MMC watcher re-decides an employee's waiting documents on every
    // arrival; the row is written once and the status still settles.
    mocks.findDocument.mockResolvedValue(
      document({ documentCode: 'PF_FORM', signatureStatus: SIGNATURE_STATUS.REVIEW_REQUIRED }),
    )
    mocks.findLatestDecision.mockResolvedValue({ outcome: STAMP_OUTCOMES.NOT_IN_LIST })

    const result = await run(5, actor, context)

    expect(result?.decision.outcome).toBe(STAMP_OUTCOMES.NOT_IN_LIST)
    expect(mocks.insertDecision).not.toHaveBeenCalled()
    expect(mocks.insertAudit).not.toHaveBeenCalled()
  })

  it('records it again once some other decision has been taken since', async () => {
    mocks.findDocument.mockResolvedValue(document({ documentCode: 'PF_FORM' }))
    mocks.findLatestDecision.mockResolvedValue({ outcome: STAMP_OUTCOMES.NO_TEMPLATE })

    await run(5, actor, context)

    expect(mocks.insertDecision).toHaveBeenCalledTimes(1)
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

/* -------------------------------------------------------------------------- */
/* Deciding again: what is already on the document stays                        */
/* -------------------------------------------------------------------------- */

function placed(
  signerRole: 'Employee' | 'Authoriser' | 'Photo',
  overrides: Record<string, unknown> = {},
) {
  return {
    signaturePlacementId: 11,
    documentId: 5,
    employeeId: 42,
    pageNumber: 1,
    x: 0.15,
    y: 0.2,
    width: 0.2,
    height: 0.2,
    pageRotation: 0,
    method: 'Manual',
    detectionMethod: 'Manual',
    confidence: null,
    signerRole,
    signerUserId: signerRole === 'Authoriser' ? 7 : null,
    signerName: signerRole === 'Authoriser' ? 'Priya Sharma' : null,
    isApplied: true,
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  }
}

/** The ESIC template: photograph, employee and HR boxes on page 1. */
const esicRows = [
  { ...templateRow('Photo', 0.1), documentTypePlacementId: 1 },
  { ...templateRow('Employee', 0.4), documentTypePlacementId: 2 },
  { ...templateRow('Authoriser', 0.7), documentTypePlacementId: 3 },
]

function esicDocument(overrides: Record<string, unknown> = {}) {
  return document({
    documentCode: 'ESIC_FORM',
    documentName: 'ESIC Form',
    signatureStatus: SIGNATURE_STATUS.REVIEW_REQUIRED,
    ...overrides,
  })
}

/** A stamp-check that found every ESIC box empty on the original. */
function esicChecked() {
  return {
    ...checkedEmpty(),
    documentCode: 'ESIC_FORM',
    documentName: 'ESIC Form',
    boxes: esicRows.map((row, index) => ({
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

describe('a document that already carries placements', () => {
  beforeEach(() => {
    mocks.autoStamp = 'stamp'
    mocks.autoStampTypes = new Set(['ESIC_FORM'])
    mocks.findDocument.mockResolvedValue(esicDocument())
    mocks.listForType.mockResolvedValue(esicRows)
    mocks.checkDocument.mockResolvedValue(esicChecked())
    mocks.readPhotoForStamp.mockResolvedValue({ data: Buffer.alloc(1), mimeType: 'image/jpeg' })
    mocks.readSignatureImages.mockResolvedValue({ Employee: {}, Authoriser: {}, Photo: {} })
  })

  it('keeps a photograph HR placed by hand, at its own rectangle, and adds the rest', async () => {
    // Document 96: the photograph by hand on the 15th, the signature saved on
    // the 16th. The photograph stays where HR put it; the employee box and
    // the HR box are added from the template.
    mocks.listPlacements.mockResolvedValue([placed('Photo')])

    const result = await run(5, actor, context, { trigger: 'signature saved' })

    expect(result?.decision.outcome).toBe(STAMP_OUTCOMES.STAMPED)
    expect(result?.decision.kept.map((box) => box.signerRole)).toEqual(['Photo'])
    expect(result?.decision.toStamp.map((box) => box.signerRole)).toEqual([
      'Employee',
      'Authoriser',
    ])
    expect(result?.decision.summary).toBe(
      'Stamped: employee signature and hr signature. Kept: employee photo (placed by hand).',
    )
    expect(result?.status).toBe(SIGNATURE_STATUS.ADDED)

    const input = mocks.applyPlacements.mock.calls[0]?.[0] as {
      boxes: { signerRole: string; x: number; method: string; detectionMethod: string }[]
      auditMetadata: Record<string, unknown>
    }
    // The whole set, repainted from the original: HR's box as it was, then
    // the two new ones.
    expect(
      input.boxes.map((box) => [box.signerRole, box.x, box.method, box.detectionMethod]),
    ).toEqual([
      ['Photo', 0.15, 'Manual', 'Manual'],
      ['Employee', 0.4, 'Automatic', 'Template'],
      ['Authoriser', 0.7, 'Automatic', 'Template'],
    ])
    expect(input.auditMetadata).toMatchObject({
      trigger: 'signature saved',
      added: [
        { signerRole: 'Employee', page: 1 },
        { signerRole: 'Authoriser', page: 1 },
      ],
      kept: [{ signerRole: 'Photo', page: 1, method: 'Manual' }],
    })
    // The kept photograph needs its image, so it was read with the others.
    expect(mocks.readSignatureImages).toHaveBeenCalledWith(
      expect.objectContaining({ photo: expect.anything() }),
    )
  })

  it('never puts a second box of a role already on the page, whoever placed the first', async () => {
    mocks.listPlacements.mockResolvedValue([
      placed('Employee', { method: 'Automatic', detectionMethod: 'Template', x: 0.5 }),
      placed('Photo', { signaturePlacementId: 12 }),
    ])

    const result = await run(5, actor, context)

    expect(result?.decision.toStamp.map((box) => box.signerRole)).toEqual(['Authoriser'])
    expect(result?.decision.kept.map((box) => box.signerRole)).toEqual(['Photo', 'Employee'])
    const input = mocks.applyPlacements.mock.calls[0]?.[0] as { boxes: { signerRole: string }[] }
    expect(input.boxes.filter((box) => box.signerRole === 'Employee')).toHaveLength(1)
    expect(result?.decision.summary).toBe(
      'Stamped: hr signature. Kept: employee photo (placed by hand); employee signature (stamped earlier).',
    )
  })

  it('leaves alone a document with nothing to add, and says what is still missing', async () => {
    mocks.listPlacements.mockResolvedValue([placed('Photo'), placed('Employee', { x: 0.5 })])
    mocks.findActiveUserSignature.mockResolvedValue(null)

    const outcome = await runOne(5, actor, context)

    expect(outcome).toMatchObject({
      left: 'nothingToAdd',
      detail:
        'still missing: the hr signature - the person who uploaded it has no signature on file',
    })
    expect(mocks.applyPlacements).not.toHaveBeenCalled()
    expect(mocks.insertDecision).not.toHaveBeenCalled()
    expect(mocks.setSignatureStatus).not.toHaveBeenCalled()
  })

  it('leaves alone a document that has every box the template has', async () => {
    mocks.listPlacements.mockResolvedValue([
      placed('Photo'),
      placed('Employee', { x: 0.5 }),
      placed('Authoriser', { x: 0.8 }),
    ])

    const outcome = await runOne(5, actor, context)

    expect(outcome).toMatchObject({
      left: 'nothingToAdd',
      detail: 'every box the template has is already on it',
    })
    expect(mocks.applyPlacements).not.toHaveBeenCalled()
  })

  it('acts as the signer of a kept HR box, so the box keeps that person’s signature', async () => {
    const other = {
      userId: 3,
      username: 'hr.other',
      fullName: 'Other HR',
      role: 'HR',
      isActive: true,
    }
    mocks.listPlacements.mockResolvedValue([
      placed('Authoriser', { signerUserId: 3, signerName: 'Other HR' }),
    ])
    mocks.findUser.mockResolvedValue(other)

    const result = await run(5, actor, context)

    expect(result?.decision.toStamp.map((box) => box.signerRole)).toEqual(['Photo', 'Employee'])
    // The HR image read is the signer's, and the run is recorded in their name.
    expect(mocks.findActiveUserSignature).toHaveBeenCalledWith(3)
    expect(mocks.insertDecision).toHaveBeenCalledWith(expect.objectContaining({ decidedBy: 3 }))
    const input = mocks.applyPlacements.mock.calls[0]?.[0] as {
      actor: { userId: number }
      boxes: { signerRole: string; signerUserId?: number | null }[]
    }
    expect(input.actor.userId).toBe(3)
    expect(input.boxes.find((box) => box.signerRole === 'Authoriser')?.signerUserId).toBe(3)
  })

  it('leaves alone a document whose kept HR box was signed by an account with no signature now', async () => {
    mocks.listPlacements.mockResolvedValue([
      placed('Authoriser', { signerUserId: 3, signerName: 'Other HR' }),
    ])
    mocks.findUser.mockResolvedValue({
      userId: 3,
      username: 'hr.other',
      fullName: 'Other HR',
      role: 'HR',
      isActive: true,
    })
    mocks.findActiveUserSignature.mockResolvedValue(null)

    const outcome = await runOne(5, actor, context)

    expect(outcome).toMatchObject({
      left: 'signerUnavailable',
      detail:
        'the hr signature already on it cannot be repainted: Other HR has no signature on file',
    })
    expect(mocks.applyPlacements).not.toHaveBeenCalled()
    expect(mocks.checkDocument).not.toHaveBeenCalled()
  })

  it('leaves alone a document whose kept HR box was signed by an account that is gone', async () => {
    mocks.listPlacements.mockResolvedValue([
      placed('Authoriser', { signerUserId: 3, signerName: 'Other HR' }),
    ])
    mocks.findUser.mockResolvedValue({ userId: 3, isActive: false })

    const outcome = await runOne(5, actor, context)

    expect(outcome).toMatchObject({ left: 'signerUnavailable' })
    expect((outcome as { detail: string }).detail).toContain('Other HR')
    expect(mocks.applyPlacements).not.toHaveBeenCalled()
  })

  it('leaves alone a document whose kept photograph is no longer on file', async () => {
    mocks.listPlacements.mockResolvedValue([placed('Photo')])
    mocks.readPhotoForStamp.mockResolvedValue(null)

    const outcome = await runOne(5, actor, context)

    expect(outcome).toMatchObject({
      left: 'imageMissing',
      detail:
        'the employee photo already on it cannot be repainted: the employee has no photograph on file',
    })
    expect(mocks.applyPlacements).not.toHaveBeenCalled()
  })

  it('does not paint a template box over a box HR placed somewhere else', async () => {
    // HR put the employee signature where the template's photograph goes.
    mocks.listPlacements.mockResolvedValue([placed('Employee', { x: 0.1, y: 0.8 })])

    const result = await run(5, actor, context)

    const photo = result?.decision.boxes.find((box) => box.signerRole === 'Photo')
    expect(photo?.action).toBe('skip')
    expect(photo?.reason).toBe('it would lie over the employee signature box placed by hand')
    expect(result?.decision.toStamp.map((box) => box.signerRole)).toEqual(['Authoriser'])
  })

  it('counts kept boxes as done, not as left alone, in the decision row', async () => {
    mocks.listPlacements.mockResolvedValue([placed('Photo')])

    await run(5, actor, context)

    expect(mocks.insertDecision).toHaveBeenCalledWith(
      expect.objectContaining({ stampedCount: 2, skippedCount: 0 }),
    )
    const boxes = (mocks.insertDecision.mock.calls[0]?.[0] as { boxes: { action: string }[] }).boxes
    expect(boxes.map((box) => box.action)).toEqual(['keep', 'stamp', 'stamp'])
  })
})

describe('deciding again for an employee', () => {
  const sleeps: number[] = []
  const deps = () => ({
    mode: () => (mocks.autoStamp === 'stamp' ? 'Stamp' : 'Report') as 'Stamp' | 'Report',
    types: () => mocks.autoStampTypes,
    listAwaiting: vi.fn(async () => [
      { documentId: 5, documentCode: 'ESIC_FORM', documentName: 'ESIC Form', uploadedBy: 9 },
      { documentId: 6, documentCode: 'PF_FORM', documentName: 'PF Form', uploadedBy: 9 },
      { documentId: 7, documentCode: 'ESIC_FORM', documentName: 'ESIC Form', uploadedBy: 404 },
    ]),
    resolveUser: vi.fn(async (id: number) =>
      id === 9 ? { ...actor, userId: 9, username: 'hr.uploader' } : null,
    ),
    runOne: vi.fn(async (documentId: number, ..._rest: unknown[]) =>
      documentId === 7
        ? { documentId, left: 'nothingToAdd' as const, detail: 'x' }
        : {
            documentId,
            mode: 'Stamp' as const,
            decision: {} as never,
            stamped: 1,
            status: SIGNATURE_STATUS.ADDED,
          },
    ),
    sleep: vi.fn(async (ms: number) => {
      sleeps.push(ms)
    }),
  })

  beforeEach(() => {
    sleeps.length = 0
    mocks.autoStamp = 'stamp'
    mocks.autoStampTypes = new Set(['ESIC_FORM'])
  })

  it('runs the listed waiting documents, in their uploaders’ names, with a breath between', async () => {
    const d = deps()
    const outcomes = await redecideForEmployee(42, actor, context, 'signature saved', d)

    // The PF form is not in the list and is not even run.
    expect(d.runOne.mock.calls.map((call) => call[0])).toEqual([5, 7])
    expect(d.runOne.mock.calls[0]?.[1]).toMatchObject({ userId: 9 })
    // The uploader of #7 is gone; the caller stands in.
    expect(d.runOne.mock.calls[1]?.[1]).toBe(actor)
    expect(d.runOne.mock.calls[0]?.[3]).toEqual({ trigger: 'signature saved' })
    expect(sleeps).toEqual([250])
    expect(outcomes.map((o) => [o.documentId, o.kind])).toEqual([
      [5, 'decided'],
      [7, 'left'],
    ])
  })

  it('does nothing at all in report mode', async () => {
    mocks.autoStamp = 'report'
    const d = deps()
    const outcomes = await redecideForEmployee(42, actor, context, 'photo saved', d)
    expect(outcomes).toEqual([])
    expect(d.listAwaiting).not.toHaveBeenCalled()
    expect(d.runOne).not.toHaveBeenCalled()
  })

  it('never throws - a save must not fail because what followed it did', async () => {
    const d = deps()
    d.listAwaiting.mockRejectedValue(new Error('database is down'))
    await expect(redecideForEmployee(42, actor, context, 'photo saved', d)).resolves.toEqual([])
  })
})

describe('deciding again for a type: the command', () => {
  const rows = [
    { documentId: 5, documentCode: 'ESIC_FORM', documentName: 'ESIC Form', uploadedBy: 9 },
    { documentId: 6, documentCode: 'ESIC_FORM', documentName: 'ESIC Form', uploadedBy: null },
  ]
  const fallback: AuthUser = { ...actor, userId: 1, username: 'admin', role: ROLES.ADMIN }

  beforeEach(() => {
    mocks.autoStamp = 'stamp'
    mocks.autoStampTypes = new Set(['ESIC_FORM'])
    mocks.findDocument.mockResolvedValue(esicDocument())
    mocks.listForType.mockResolvedValue(esicRows)
    mocks.checkDocument.mockResolvedValue(esicChecked())
    mocks.readPhotoForStamp.mockResolvedValue({ data: Buffer.alloc(1), mimeType: 'image/jpeg' })
    mocks.readSignatureImages.mockResolvedValue({ Employee: {}, Authoriser: {}, Photo: {} })
    mocks.listPlacements.mockResolvedValue([placed('Photo')])
  })

  it('a dry run reads and decides and writes nothing - not even to the record', async () => {
    const seen: string[] = []
    const outcomes = await redecideType(rows, {
      dryRun: true,
      fallback,
      context,
      resolveUploader: async () => null,
      onEach: (o) => seen.push(`${o.documentId} ${o.kind}`),
      sleep: async () => {},
    })

    expect(seen).toEqual(['5 preview', '6 preview'])
    const first = outcomes[0]
    expect(first?.kind).toBe('preview')
    if (first?.kind === 'preview') {
      expect(first.decision.toStamp.map((box) => box.signerRole)).toEqual([
        'Employee',
        'Authoriser',
      ])
      expect(first.decision.kept.map((box) => box.signerRole)).toEqual(['Photo'])
    }
    expect(mocks.attachQuietly).not.toHaveBeenCalled()
    expect(mocks.insertDecision).not.toHaveBeenCalled()
    expect(mocks.insertAudit).not.toHaveBeenCalled()
    expect(mocks.setSignatureStatus).not.toHaveBeenCalled()
    expect(mocks.applyPlacements).not.toHaveBeenCalled()
  })

  it('a live run stamps, in the uploader’s name where there is one', async () => {
    const uploader = { ...actor, userId: 9, username: 'hr.uploader' }
    const sleeps: number[] = []
    const outcomes = await redecideType(rows, {
      dryRun: false,
      fallback,
      context,
      resolveUploader: async (id) => (id === 9 ? uploader : null),
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    expect(outcomes.map((o) => o.kind)).toEqual(['decided', 'decided'])
    expect(mocks.applyPlacements).toHaveBeenCalledTimes(2)
    const actors = mocks.applyPlacements.mock.calls.map(
      (call) => (call[0] as { actor: { userId: number } }).actor.userId,
    )
    expect(actors).toEqual([9, 1])
    expect(sleeps).toEqual([250])
    const meta = (
      mocks.applyPlacements.mock.calls[0]?.[0] as { auditMetadata: { trigger: string } }
    ).auditMetadata
    expect(meta.trigger).toBe('redecide command')
  })

  it('reports a document left alone, and carries on', async () => {
    // The first has everything already, its HR box signed by the fallback
    // itself; the second wants two boxes.
    mocks.listPlacements
      .mockResolvedValueOnce([
        placed('Photo'),
        placed('Employee', { x: 0.5 }),
        placed('Authoriser', { x: 0.8, signerUserId: 1 }),
      ])
      .mockResolvedValueOnce([placed('Photo')])

    const outcomes = await redecideType(rows, {
      dryRun: false,
      fallback,
      context,
      resolveUploader: async () => null,
      sleep: async () => {},
    })

    expect(outcomes[0]).toMatchObject({ kind: 'left', reason: 'nothingToAdd' })
    expect(outcomes[1]).toMatchObject({ kind: 'decided' })
    expect(mocks.applyPlacements).toHaveBeenCalledTimes(1)
  })
})
