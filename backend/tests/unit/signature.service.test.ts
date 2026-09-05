import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUDIT_ACTIONS,
  DOCUMENT_STATUS,
  ROLES,
  SIGNATURE_STATUS,
  type AuthUser,
} from '@asps-dms/shared'

/**
 * Signatures, their placements and the signed output.
 *
 * The rule worth a test more than any other: the processed PDF is rebuilt from
 * the ORIGINAL every single time. Stamping the previous output would compound
 * every placement ever made, and a corrected placement would leave the wrong
 * one visible underneath the right one - on a real employee document.
 */

const db = vi.hoisted(() => ({
  findDocument: vi.fn(),
  findStoredFile: vi.fn(),
  setProcessedFile: vi.fn(),
  setSignatureStatus: vi.fn(),
  findEmployee: vi.fn(),
  findActiveSignature: vi.fn(),
  replaceActiveSignature: vi.fn(),
  listPlacements: vi.fn(),
  replacePlacements: vi.fn(),
  markApplied: vi.fn(),
  insertAudit: vi.fn(),
  readStoredFile: vi.fn(),
  storeProcessed: vi.fn(),
  storeSignature: vi.fn(),
  discardStoredFile: vi.fn(),
  storedFileExists: vi.fn(),
  openStoredFile: vi.fn(),
  stampSignature: vi.fn(),
}))

vi.mock('../../src/database/pool.js', () => ({
  withTransaction: async <T>(work: (tx: unknown) => Promise<T>) => work({}),
}))

vi.mock('../../src/repositories/employeeDocument.repository.js', () => ({
  findById: db.findDocument,
  findStoredFile: db.findStoredFile,
  setProcessedFile: db.setProcessedFile,
  setSignatureStatus: db.setSignatureStatus,
  attachFile: vi.fn(),
  setStatus: vi.fn(),
  setDueDate: vi.fn(),
  listForEmployee: vi.fn(),
  createChecklist: vi.fn(),
  listDocumentTypeIdsForEmployee: vi.fn(),
}))

vi.mock('../../src/repositories/employee.repository.js', () => ({
  findById: db.findEmployee,
  create: vi.fn(),
  update: vi.fn(),
  setActive: vi.fn(),
  list: vi.fn(),
  listFacets: vi.fn(),
}))

vi.mock('../../src/repositories/employeeSignature.repository.js', () => ({
  findActiveByEmployee: db.findActiveSignature,
  replaceActive: db.replaceActiveSignature,
}))

vi.mock('../../src/repositories/signaturePlacement.repository.js', () => ({
  listForDocument: db.listPlacements,
  replaceForDocument: db.replacePlacements,
  markApplied: db.markApplied,
}))

vi.mock('../../src/services/storage.service.js', () => ({
  readStoredFile: db.readStoredFile,
  storeProcessedDocument: db.storeProcessed,
  storeSignature: db.storeSignature,
  discardStoredFile: db.discardStoredFile,
  storedFileExists: db.storedFileExists,
  openStoredFile: db.openStoredFile,
  storeDocument: vi.fn(),
  ensureStorageReady: vi.fn(),
  checkStorageWritable: vi.fn(),
  resolveWithinRoot: vi.fn(),
}))

vi.mock('../../src/services/signatureStamp.service.js', () => ({
  stampSignature: db.stampSignature,
  toDrawParams: vi.fn(),
}))

vi.mock('../../src/repositories/audit.repository.js', () => ({ insert: db.insertAudit }))

const signatureService = await import('../../src/services/signature.service.js')

const hr: AuthUser = {
  userId: 3,
  username: 'hr1',
  fullName: 'Priya Sharma',
  role: ROLES.HR,
  mustChangePassword: false,
}
const context = { ipAddress: '10.0.0.5', userAgent: 'test' }

const documentRecord = {
  documentId: 5,
  employeeId: 42,
  employeeCode: 'EMP001',
  employeeName: 'Ravi Kumar',
  documentTypeId: 1,
  documentName: 'Offer Letter',
  isMandatory: true,
  requiresSignature: true,
  originalFileName: 'offer.pdf',
  fileSizeBytes: 2048,
  mimeType: 'application/pdf',
  pageCount: 2,
  hasProcessedFile: false,
  status: DOCUMENT_STATUS.UPLOADED,
  signatureStatus: SIGNATURE_STATUS.REVIEW_REQUIRED,
  dueDate: null,
  uploadedByName: 'Priya Sharma',
  uploadedAt: '2026-09-02T04:00:00.000Z',
  verifiedByName: null,
  verifiedAt: null,
  rejectionReason: null,
  createdAt: '2026-09-01T04:00:00.000Z',
  updatedAt: '2026-09-02T04:00:00.000Z',
}

const storedFile = {
  documentId: 5,
  employeeId: 42,
  originalFilePath: 'documents/42/original.pdf',
  processedFilePath: null,
  originalFileName: 'offer.pdf',
  mimeType: 'application/pdf',
  documentName: 'Offer Letter',
  employeeCode: 'EMP001',
}

const signatureRecord = {
  employeeSignatureId: 1,
  employeeId: 42,
  relativePath: 'signatures/42/sig.png',
  mimeType: 'image/png',
  originalFileName: 'signature.png',
  fileSizeBytes: 4096,
  widthPx: 300,
  heightPx: 120,
  uploadedAt: '2026-09-01T04:00:00.000Z',
  updatedAt: '2026-09-01T04:00:00.000Z',
}

const placement = {
  pageNumber: 1,
  x: 0.1,
  y: 0.8,
  width: 0.2,
  height: 0.08,
  pageRotation: 0 as const,
  method: 'Manual' as const,
  detectionMethod: 'Manual' as const,
  signerRole: 'Employee' as const,
  confidence: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  db.insertAudit.mockResolvedValue(undefined)
  db.findDocument.mockResolvedValue(documentRecord)
  db.findStoredFile.mockResolvedValue(storedFile)
  db.findActiveSignature.mockResolvedValue(signatureRecord)
  db.readStoredFile.mockResolvedValue(Buffer.from('bytes'))
  db.stampSignature.mockResolvedValue(Buffer.from('%PDF-signed'))
  db.storeProcessed.mockResolvedValue({
    storedFileName: 'signed.pdf',
    relativePath: 'processed/42/signed.pdf',
    sizeBytes: 11,
    sha256: Buffer.alloc(32, 2),
  })
  db.replacePlacements.mockResolvedValue(undefined)
  db.setProcessedFile.mockResolvedValue(undefined)
  db.markApplied.mockResolvedValue(undefined)
  db.setSignatureStatus.mockResolvedValue(true)
  db.storedFileExists.mockResolvedValue(true)
})

describe('savePlacements', () => {
  it('stamps the ORIGINAL, never the previously processed file', async () => {
    db.findStoredFile.mockResolvedValue({
      ...storedFile,
      processedFilePath: 'processed/42/an-earlier-signed-copy.pdf',
    })

    await signatureService.savePlacements(5, { placements: [placement] }, hr, context)

    // Signing again after a correction must start from the unsigned document,
    // or both signatures end up on the page.
    expect(db.readStoredFile).toHaveBeenCalledWith('documents/42/original.pdf')
    expect(db.readStoredFile).not.toHaveBeenCalledWith('processed/42/an-earlier-signed-copy.pdf')
  })

  it('records the signed copy and marks the placements applied', async () => {
    await signatureService.savePlacements(5, { placements: [placement] }, hr, context)

    expect(db.setProcessedFile).toHaveBeenCalledWith(
      5,
      'processed/42/signed.pdf',
      SIGNATURE_STATUS.ADDED,
    )
    expect(db.markApplied).toHaveBeenCalledWith(5)
  })

  it('refuses when the employee has no signature on file', async () => {
    db.findActiveSignature.mockResolvedValue(null)

    await expect(
      signatureService.savePlacements(5, { placements: [placement] }, hr, context),
    ).rejects.toMatchObject({ statusCode: 409 })

    expect(db.stampSignature).not.toHaveBeenCalled()
    expect(db.replacePlacements).not.toHaveBeenCalled()
  })

  it('refuses when the document has no file yet', async () => {
    db.findDocument.mockResolvedValue({ ...documentRecord, originalFileName: null })

    await expect(
      signatureService.savePlacements(5, { placements: [placement] }, hr, context),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('removes the signed copy when the placements are cleared', async () => {
    db.findStoredFile.mockResolvedValue({
      ...storedFile,
      processedFilePath: 'processed/42/signed.pdf',
    })

    await signatureService.savePlacements(5, { placements: [] }, hr, context)

    expect(db.replacePlacements).toHaveBeenCalledWith(5, 42, [], 3)
    // The processed file shows a signature that is no longer placed, and it is
    // served in preference to the original, so it must not be left behind.
    expect(db.setProcessedFile).toHaveBeenCalledWith(5, null, SIGNATURE_STATUS.REVIEW_REQUIRED)
    expect(db.discardStoredFile).toHaveBeenCalledWith('processed/42/signed.pdf')
    expect(db.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.SIGNATURE_REMOVED }),
    )
  })

  it('deletes the generated file when the rows cannot be saved', async () => {
    db.replacePlacements.mockRejectedValue(new Error('database is down'))

    await expect(
      signatureService.savePlacements(5, { placements: [placement] }, hr, context),
    ).rejects.toThrow()

    expect(db.discardStoredFile).toHaveBeenCalledWith('processed/42/signed.pdf')
  })

  it('records where the signature was put, not merely that one was', async () => {
    await signatureService.savePlacements(5, { placements: [placement] }, hr, context)

    const entry = db.insertAudit.mock.calls[0]?.[0]
    expect(entry.action).toBe(AUDIT_ACTIONS.SIGNATURE_PLACED_MANUALLY)
    const metadata = JSON.parse(entry.metadataJson ?? '{}') as {
      rects: { page: number; x: number }[]
    }
    expect(metadata.rects[0]).toMatchObject({ page: 1, x: 0.1, method: 'Manual' })
  })

  it('tells accepting a detection apart from adjusting one', async () => {
    await signatureService.savePlacements(
      5,
      { placements: [{ ...placement, method: 'Automatic', detectionMethod: 'CV', confidence: 0.9 }] },
      hr,
      context,
    )
    expect(db.insertAudit.mock.calls[0]?.[0].action).toBe(AUDIT_ACTIONS.SIGNATURE_ACCEPTED)

    vi.clearAllMocks()
    db.insertAudit.mockResolvedValue(undefined)

    await signatureService.savePlacements(
      5,
      { placements: [{ ...placement, method: 'Adjusted', detectionMethod: 'CV', confidence: 0.9 }] },
      hr,
      context,
    )
    expect(db.insertAudit.mock.calls[0]?.[0].action).toBe(AUDIT_ACTIONS.SIGNATURE_ADJUSTED)
  })
})

describe('skipSignature', () => {
  it('marks a document as deliberately not signed', async () => {
    await signatureService.skipSignature(5, 'Not required for this hire', hr, context)

    expect(db.setSignatureStatus).toHaveBeenCalledWith(
      5,
      SIGNATURE_STATUS.REVIEW_REQUIRED,
      SIGNATURE_STATUS.SKIPPED,
    )
    expect(db.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.SIGNATURE_SKIPPED }),
    )
  })

  it('refuses a signature state the machine cannot leave', async () => {
    db.findDocument.mockResolvedValue({
      ...documentRecord,
      signatureStatus: SIGNATURE_STATUS.NOT_REQUIRED,
    })

    await expect(signatureService.skipSignature(5, undefined, hr, context)).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(db.setSignatureStatus).not.toHaveBeenCalled()
  })

  it('reports a conflict when someone else moved it first', async () => {
    db.setSignatureStatus.mockResolvedValue(false)

    await expect(signatureService.skipSignature(5, undefined, hr, context)).rejects.toMatchObject({
      statusCode: 409,
    })
    expect(db.insertAudit).not.toHaveBeenCalled()
  })
})

describe('uploadSignature', () => {
  /** A real 1x1 PNG: the service embeds it to measure it, so it must decode. */
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )

  const employee = {
    employeeId: 42,
    employeeCode: 'EMP001',
    employeeName: 'Ravi Kumar',
    joiningDate: '2026-09-01',
    department: null,
    designation: null,
    isActive: true,
    createdAt: '2026-09-01T04:00:00.000Z',
    updatedAt: '2026-09-01T04:00:00.000Z',
    counts: { total: 1, completed: 0, pending: 1, overdue: 0, signatureReviewRequired: 1 },
    hasSignature: false,
    signatureUpdatedAt: null,
  }

  beforeEach(() => {
    db.findEmployee.mockResolvedValue(employee)
    db.findActiveSignature.mockResolvedValue(null)
    db.replaceActiveSignature.mockResolvedValue(1)
    db.storeSignature.mockResolvedValue({
      storedFileName: 'sig.png',
      relativePath: 'signatures/42/sig.png',
      sizeBytes: PNG_1X1.byteLength,
      sha256: Buffer.alloc(32, 3),
    })
  })

  it('measures the image and stores it', async () => {
    await signatureService.uploadSignature(
      42,
      { originalname: 'my-signature.png', buffer: PNG_1X1, size: PNG_1X1.byteLength },
      hr,
      context,
    )

    expect(db.replaceActiveSignature).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 42, widthPx: 1, heightPx: 1, mimeType: 'image/png' }),
    )
    expect(db.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.SIGNATURE_UPLOADED }),
    )
  })

  it('records a replacement as a replacement', async () => {
    db.findActiveSignature.mockResolvedValue(signatureRecord)

    await signatureService.uploadSignature(
      42,
      { originalname: 'new.png', buffer: PNG_1X1, size: PNG_1X1.byteLength },
      hr,
      context,
    )

    expect(db.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.SIGNATURE_REPLACED }),
    )
  })

  it('refuses a PDF, however it is named', async () => {
    await expect(
      signatureService.uploadSignature(
        42,
        {
          originalname: 'signature.png',
          buffer: Buffer.from('%PDF-1.4 this is a document'),
          size: 27,
        },
        hr,
        context,
      ),
    ).rejects.toMatchObject({ statusCode: 415 })

    expect(db.storeSignature).not.toHaveBeenCalled()
  })

  it('404s for an employee that does not exist', async () => {
    db.findEmployee.mockResolvedValue(null)

    await expect(
      signatureService.uploadSignature(
        999,
        { originalname: 'sig.png', buffer: PNG_1X1, size: PNG_1X1.byteLength },
        hr,
        context,
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})
