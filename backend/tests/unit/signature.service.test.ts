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
  findPhoto: vi.fn(),
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
  assessBoxes: vi.fn(),
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
  findPhoto: db.findPhoto,
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

// The occupancy check has its own tests against real PDFs; here it is an
// oracle whose answer savePlacements has to respect.
vi.mock('../../src/services/boxOccupancy.service.js', () => ({ assessBoxes: db.assessBoxes }))

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
  documentCode: 'OFFER_LETTER',
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

/** 1x1 PNG: real bytes, because the photograph is read by sharp for its orientation. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const esicForm = { ...documentRecord, documentName: 'ESIC Form', documentCode: 'ESIC_FORM' }

/** What the occupancy service says about a box, for the shape savePlacements reads. */
function assessed(
  verdict: 'empty' | 'occupied' | 'uncertain',
  extra: Record<string, unknown> = {},
) {
  return {
    label: '0',
    signerRole: 'Employee',
    pageNumber: 1,
    rect: { x: 0.1, y: 0.8, width: 0.2, height: 0.08 },
    verdict,
    decidedBy: verdict === 'empty' ? 'none' : 'image',
    pageKind: 'digital',
    overlap: { images: verdict === 'empty' ? 0 : 1, coverage: verdict === 'empty' ? 0 : 0.97 },
    reason: verdict === 'empty' ? 'no image on the box' : 'an image covers 97% of the box',
    ...extra,
  }
}
const photoBox = { ...placement, signerRole: 'Photo' as const, y: 0.1, width: 0.15, height: 0.12 }

beforeEach(() => {
  vi.clearAllMocks()
  db.insertAudit.mockResolvedValue(undefined)
  db.findDocument.mockResolvedValue(documentRecord)
  db.findPhoto.mockResolvedValue(null)
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
  db.assessBoxes.mockImplementation((_source: Buffer, _mime: string, boxes: unknown[]) =>
    Promise.resolve(boxes.map(() => assessed('empty'))),
  )
})

describe('checkPlacements', () => {
  it('asks about the ORIGINAL file, never the signed copy', async () => {
    db.findStoredFile.mockResolvedValue({
      ...storedFile,
      processedFilePath: 'processed/42/signed.pdf',
    })

    await signatureService.checkPlacements(5, { placements: [placement] })

    expect(db.readStoredFile).toHaveBeenCalledWith('documents/42/original.pdf')
    expect(db.readStoredFile).not.toHaveBeenCalledWith('processed/42/signed.pdf')
    expect(db.assessBoxes).toHaveBeenCalledWith(
      Buffer.from('bytes'),
      'application/pdf',
      [
        {
          label: '0',
          signerRole: 'Employee',
          pageNumber: 1,
          rect: { x: 0.1, y: 0.8, width: 0.2, height: 0.08 },
        },
      ],
    )
  })

  it('answers each box by its position in the request', async () => {
    db.assessBoxes.mockResolvedValue([
      assessed('empty'),
      assessed('occupied', {
        decidedBy: 'ink',
        pageKind: 'scanned',
        overlap: { images: 0, coverage: 0 },
        ink: { percent: 6.1, background: 231, cutoff: 191 },
        reason: 'ink covers 6.1% of the box',
      }),
    ])

    const occupancy = await signatureService.checkPlacements(5, {
      placements: [placement, { ...placement, signerRole: 'Authoriser', pageNumber: 2 }],
    })

    expect(occupancy).toEqual([
      expect.objectContaining({ index: 0, signerRole: 'Employee', verdict: 'empty' }),
      expect.objectContaining({
        index: 1,
        signerRole: 'Authoriser',
        verdict: 'occupied',
        decidedBy: 'ink',
        ink: { percent: 6.1, background: 231, cutoff: 191 },
      }),
    ])
    // No box was written; the answer is the whole of the effect.
    expect(db.stampSignature).not.toHaveBeenCalled()
    expect(db.replacePlacements).not.toHaveBeenCalled()
    expect(db.insertAudit).not.toHaveBeenCalled()
  })

  it('refuses when the document has no file to look at', async () => {
    db.findDocument.mockResolvedValue({ ...documentRecord, originalFileName: null })
    await expect(
      signatureService.checkPlacements(5, { placements: [placement] }),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(db.assessBoxes).not.toHaveBeenCalled()
  })
})

describe('savePlacements over something already there', () => {
  it('refuses to stamp a box that already has something in it', async () => {
    db.assessBoxes.mockResolvedValue([assessed('occupied')])

    await expect(
      signatureService.savePlacements(
        5,
        { acknowledgeOccupied: false, placements: [placement] },
        hr,
        context,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'The employee signature box on page 1 already has something in it (an image covers 97% of the box).',
      details: {
        occupancy: [expect.objectContaining({ index: 0, verdict: 'occupied', decidedBy: 'image' })],
      },
    })

    expect(db.stampSignature).not.toHaveBeenCalled()
    expect(db.replacePlacements).not.toHaveBeenCalled()
    expect(db.insertAudit).not.toHaveBeenCalled()
  })

  it('treats a box it cannot decide about the same way', async () => {
    db.assessBoxes.mockResolvedValue([
      assessed('uncertain', {
        decidedBy: 'ink',
        pageKind: 'scanned',
        overlap: { images: 0, coverage: 0 },
        ink: { percent: 2.4, background: 231, cutoff: 191 },
        reason: 'ink covers 2.4% of the box, between the empty and occupied lines',
      }),
    ])

    await expect(
      signatureService.savePlacements(
        5,
        { acknowledgeOccupied: false, placements: [placement] },
        hr,
        context,
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(db.stampSignature).not.toHaveBeenCalled()
  })

  it('counts the boxes when more than one is in question', async () => {
    db.assessBoxes.mockResolvedValue([assessed('occupied'), assessed('empty'), assessed('occupied')])

    await expect(
      signatureService.savePlacements(
        5,
        {
          acknowledgeOccupied: false,
          placements: [placement, { ...placement, y: 0.5 }, { ...placement, y: 0.3 }],
        },
        hr,
        context,
      ),
    ).rejects.toMatchObject({ message: '2 of the boxes already have something in them.' })
  })

  it('stamps anyway when HR has seen the numbers and said so, and records it', async () => {
    db.assessBoxes.mockResolvedValue([
      assessed('empty'),
      assessed('occupied', {
        pageNumber: 2,
        decidedBy: 'ink',
        pageKind: 'scanned',
        overlap: { images: 0, coverage: 0 },
        ink: { percent: 6.123, background: 231, cutoff: 191 },
        reason: 'ink covers 6.1% of the box',
      }),
    ])

    await signatureService.savePlacements(
      5,
      {
        acknowledgeOccupied: true,
        placements: [placement, { ...placement, pageNumber: 2 }],
      },
      hr,
      context,
    )

    expect(db.stampSignature).toHaveBeenCalledTimes(1)
    const entry = db.insertAudit.mock.calls[0]?.[0]
    const metadata = JSON.parse(entry.metadataJson ?? '{}') as {
      acknowledgedOccupied: unknown[]
    }
    // Only the box that was in question, with what was measured - not the
    // empty one, and not a bare 'yes'.
    expect(metadata.acknowledgedOccupied).toEqual([
      {
        index: 1,
        signerRole: 'Employee',
        page: 2,
        verdict: 'occupied',
        decidedBy: 'ink',
        coverage: 0,
        inkPercent: 6.12,
      },
    ])
  })

  it('records nothing acknowledged when every box was empty', async () => {
    await signatureService.savePlacements(
      5,
      { acknowledgeOccupied: true, placements: [placement] },
      hr,
      context,
    )
    const metadata = JSON.parse(db.insertAudit.mock.calls[0]?.[0].metadataJson ?? '{}') as {
      acknowledgedOccupied: unknown[]
    }
    expect(metadata.acknowledgedOccupied).toEqual([])
  })

  it('checks before it reads the signature images, so a refusal costs nothing', async () => {
    db.assessBoxes.mockResolvedValue([assessed('occupied')])
    await expect(
      signatureService.savePlacements(
        5,
        { acknowledgeOccupied: false, placements: [placement] },
        hr,
        context,
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(db.readStoredFile).not.toHaveBeenCalledWith('signatures/42/sig.png')
  })
})

describe('savePlacements', () => {
  it('stamps the ORIGINAL, never the previously processed file', async () => {
    db.findStoredFile.mockResolvedValue({
      ...storedFile,
      processedFilePath: 'processed/42/an-earlier-signed-copy.pdf',
    })

    await signatureService.savePlacements(5, { acknowledgeOccupied: false, placements: [placement] }, hr, context)

    // Signing again after a correction must start from the unsigned document,
    // or both signatures end up on the page.
    expect(db.readStoredFile).toHaveBeenCalledWith('documents/42/original.pdf')
    expect(db.readStoredFile).not.toHaveBeenCalledWith('processed/42/an-earlier-signed-copy.pdf')
  })

  it('records the signed copy and marks the placements applied', async () => {
    await signatureService.savePlacements(5, { acknowledgeOccupied: false, placements: [placement] }, hr, context)

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
      signatureService.savePlacements(5, { acknowledgeOccupied: false, placements: [placement] }, hr, context),
    ).rejects.toMatchObject({ statusCode: 409 })

    expect(db.stampSignature).not.toHaveBeenCalled()
    expect(db.replacePlacements).not.toHaveBeenCalled()
  })

  it('refuses when the document has no file yet', async () => {
    db.findDocument.mockResolvedValue({ ...documentRecord, originalFileName: null })

    await expect(
      signatureService.savePlacements(5, { acknowledgeOccupied: false, placements: [placement] }, hr, context),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  describe('the employee photograph', () => {
    beforeEach(() => {
      db.findDocument.mockResolvedValue(esicForm)
      db.findPhoto.mockResolvedValue({ filePath: 'photos/42/photo.png', mimeType: 'image/png' })
      db.readStoredFile.mockImplementation(async (path: string) =>
        path === 'photos/42/photo.png' ? PNG_1X1 : Buffer.from('bytes'),
      )
    })

    it('hands the photograph to the stamper under its own role', async () => {
      await signatureService.savePlacements(5, { acknowledgeOccupied: false, placements: [placement, photoBox] }, hr, context)

      const [input] = db.stampSignature.mock.calls[0] ?? []
      expect(input.signatures.Photo).toEqual({ data: PNG_1X1, mimeType: 'image/png' })
      expect(input.placements.map((p: { signerRole: string }) => p.signerRole)).toEqual([
        'Employee',
        'Photo',
      ])
    })

    it('does NOT mark the document signed when only a photograph was placed', async () => {
      await signatureService.savePlacements(5, { acknowledgeOccupied: false, placements: [photoBox] }, hr, context)

      // The PDF is rebuilt and the box is kept - a photograph is a valid stamp.
      expect(db.stampSignature).toHaveBeenCalled()
      expect(db.replacePlacements).toHaveBeenCalled()
      expect(db.markApplied).toHaveBeenCalledWith(5)
      // But nothing was signed, so the status is exactly what it was: the
      // checklist does not read 'Signature added', and skipping stays open.
      expect(db.setProcessedFile).toHaveBeenCalledWith(
        5,
        'processed/42/signed.pdf',
        SIGNATURE_STATUS.REVIEW_REQUIRED,
      )
      // And no signature image was asked for.
      expect(db.findActiveSignature).not.toHaveBeenCalled()
    })

    it('marks it signed when a signature box is placed alongside the photograph', async () => {
      await signatureService.savePlacements(5, { acknowledgeOccupied: false, placements: [photoBox, placement] }, hr, context)

      expect(db.setProcessedFile).toHaveBeenCalledWith(
        5,
        'processed/42/signed.pdf',
        SIGNATURE_STATUS.ADDED,
      )
    })

    it('refuses a photograph on any document but the ESIC form', async () => {
      db.findDocument.mockResolvedValue(documentRecord)

      await expect(
        signatureService.savePlacements(5, { acknowledgeOccupied: false, placements: [placement, photoBox] }, hr, context),
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('ESIC') })

      expect(db.stampSignature).not.toHaveBeenCalled()
      expect(db.replacePlacements).not.toHaveBeenCalled()
    })

    it('refuses when the employee has no photograph on file', async () => {
      db.findPhoto.mockResolvedValue(null)

      await expect(
        signatureService.savePlacements(5, { acknowledgeOccupied: false, placements: [photoBox] }, hr, context),
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('photograph') })

      expect(db.stampSignature).not.toHaveBeenCalled()
    })

    it('refuses when the photograph is recorded but the file has gone', async () => {
      db.storedFileExists.mockImplementation(async (path: string) => path !== 'photos/42/photo.png')

      await expect(
        signatureService.savePlacements(5, { acknowledgeOccupied: false, placements: [photoBox] }, hr, context),
      ).rejects.toMatchObject({ statusCode: 409 })
    })
  })

  it('removes the signed copy when the placements are cleared', async () => {
    db.findStoredFile.mockResolvedValue({
      ...storedFile,
      processedFilePath: 'processed/42/signed.pdf',
    })

    await signatureService.savePlacements(5, { acknowledgeOccupied: false, placements: [] }, hr, context)

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
      signatureService.savePlacements(5, { acknowledgeOccupied: false, placements: [placement] }, hr, context),
    ).rejects.toThrow()

    expect(db.discardStoredFile).toHaveBeenCalledWith('processed/42/signed.pdf')
  })

  it('records where the signature was put, not merely that one was', async () => {
    await signatureService.savePlacements(5, { acknowledgeOccupied: false, placements: [placement] }, hr, context)

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
      { acknowledgeOccupied: false, placements: [{ ...placement, method: 'Automatic', detectionMethod: 'CV', confidence: 0.9 }] },
      hr,
      context,
    )
    expect(db.insertAudit.mock.calls[0]?.[0].action).toBe(AUDIT_ACTIONS.SIGNATURE_ACCEPTED)

    vi.clearAllMocks()
    db.insertAudit.mockResolvedValue(undefined)

    await signatureService.savePlacements(
      5,
      { acknowledgeOccupied: false, placements: [{ ...placement, method: 'Adjusted', detectionMethod: 'CV', confidence: 0.9 }] },
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
