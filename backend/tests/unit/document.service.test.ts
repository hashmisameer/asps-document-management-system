import { PDFDocument, StandardFonts } from 'pdf-lib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  API_ERROR_CODES,
  AUDIT_ACTIONS,
  DOCUMENT_STATUS,
  ROLES,
  SIGNATURE_STATUS,
  type AuthUser,
} from '@asps-dms/shared'
import type { EmployeeDocumentRecord } from '../../src/repositories/employeeDocument.repository.js'

/**
 * Uploading, verifying and rejecting a document.
 *
 * The rules being pinned here are the ones that are expensive to get wrong: a
 * status change the state machine forbids is refused rather than written, a
 * file whose contents do not match its name never reaches the store, and a row
 * that fails to save does not leave its file behind.
 */

const db = vi.hoisted(() => ({
  findById: vi.fn(),
  findStoredFile: vi.fn(),
  attachFile: vi.fn(),
  setStatus: vi.fn(),
  setDueDate: vi.fn(),
  insertAudit: vi.fn(),
  storeDocument: vi.fn(),
  discardStoredFile: vi.fn(),
  openStoredFile: vi.fn(),
  storedFileExists: vi.fn(),
  findDocumentType: vi.fn(),
  findEmployee: vi.fn(),
  extractText: vi.fn(),
  recordIdentityCheck: vi.fn(),
  setNotRequired: vi.fn(),
  readStoredFile: vi.fn(),
}))

vi.mock('../../src/repositories/employeeDocument.repository.js', () => ({
  findById: db.findById,
  findStoredFile: db.findStoredFile,
  attachFile: db.attachFile,
  setStatus: db.setStatus,
  setDueDate: db.setDueDate,
  listForEmployee: vi.fn(),
  createChecklist: vi.fn(),
  listDocumentTypeIdsForEmployee: vi.fn(),
  recordIdentityCheck: db.recordIdentityCheck,
  setNotRequired: db.setNotRequired,
}))

vi.mock('../../src/services/storage.service.js', () => ({
  storeDocument: db.storeDocument,
  discardStoredFile: db.discardStoredFile,
  openStoredFile: db.openStoredFile,
  storedFileExists: db.storedFileExists,
  readStoredFile: db.readStoredFile,
  ensureStorageReady: vi.fn(),
  checkStorageWritable: vi.fn(),
  resolveWithinRoot: vi.fn(),
}))

vi.mock('../../src/repositories/audit.repository.js', () => ({ insert: db.insertAudit }))

// The identity check reads the document type's field list and the employee's
// record. Both are stubbed to the uninteresting answer by default - a type that
// asks for nothing - so the tests here stay about upload, and the check itself
// is pinned in documentVerification.test.ts.
vi.mock('../../src/repositories/documentType.repository.js', () => ({
  findById: db.findDocumentType,
  listActive: vi.fn(),
  listAll: vi.fn(),
}))

vi.mock('../../src/repositories/employee.repository.js', () => ({
  findById: db.findEmployee,
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setActive: vi.fn(),
  listFacets: vi.fn(),
}))

// Reading a PDF is pdf.js's job and is not what these tests are about; what
// they are about is what the service does with the words that come back.
vi.mock('../../src/services/documentText.service.js', () => ({
  extractText: db.extractText,
  closeOcrWorker: vi.fn(),
}))

const documentService = await import('../../src/services/document.service.js')

const hr: AuthUser = {
  userId: 3,
  username: 'hr1',
  fullName: 'Priya Sharma',
  role: ROLES.HR,
  mustChangePassword: false,
}

const viewer: AuthUser = { ...hr, userId: 9, username: 'mgr1', role: ROLES.VIEWER }
const context = { ipAddress: '10.0.0.5', userAgent: 'test' }

/**
 * A real PDF, built rather than hand-written.
 *
 * It used to be a few literal bytes beginning '%PDF-', which was enough while
 * the upload only read the first few. It is not any more: the file is opened
 * now and asked how many pages it has, and those bytes were never a PDF that
 * would open - the fixture would have been refused exactly as a truncated
 * upload is.
 */
async function realPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([595.28, 841.89]).drawText('PAN CARD', { x: 60, y: 700, font, size: 18 })
  return Buffer.from(await pdf.save())
}

const PDF_BYTES = await realPdf()

function uploadedFile(overrides: Partial<{ originalname: string; buffer: Buffer }> = {}) {
  const buffer = overrides.buffer ?? PDF_BYTES
  return {
    originalname: overrides.originalname ?? 'pan-card.pdf',
    buffer,
    size: buffer.byteLength,
  }
}

function record(overrides: Partial<EmployeeDocumentRecord> = {}): EmployeeDocumentRecord {
  return {
    documentId: 5,
    employeeId: 42,
    employeeCode: 'EMP001',
    // Still here, so their deadlines are still running.
    employeeHasLeft: false,
    deadlineUnit: null,
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
    notRequiredAt: null,
    notRequiredByName: null,
    dueDate: '2026-09-11',
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

const uploadInput = {
  isExistingRecord: false,
  landingStatus: DOCUMENT_STATUS.UPLOADED,
} as const

beforeEach(() => {
  vi.clearAllMocks()
  db.insertAudit.mockResolvedValue(undefined)
  db.findById.mockResolvedValue(record())
  db.findDocumentType.mockResolvedValue({
    documentTypeId: 1,
    documentName: 'Test Document',
    requiredFields: [],
    recognitionKeywords: [],
  })
  db.findEmployee.mockResolvedValue(null)
  db.extractText.mockResolvedValue({ text: '', source: 'None', pagesRead: 0 })
  db.attachFile.mockResolvedValue(undefined)
  db.setStatus.mockResolvedValue(true)
  db.setDueDate.mockResolvedValue(true)
  db.storedFileExists.mockResolvedValue(true)
  db.storeDocument.mockResolvedValue({
    storedFileName: 'uuid.pdf',
    relativePath: 'documents/42/uuid.pdf',
    sizeBytes: PDF_BYTES.byteLength,
    sha256: Buffer.alloc(32, 1),
  })
})

describe('uploadFile', () => {
  it('stores the file and moves a pending document to Uploaded', async () => {
    await documentService.uploadFile(5, uploadedFile(), uploadInput, hr, context)

    expect(db.storeDocument).toHaveBeenCalledWith(42, expect.any(Buffer), '.pdf')
    expect(db.attachFile).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 5,
        status: DOCUMENT_STATUS.UPLOADED,
        mimeType: 'application/pdf',
        // Never the uploaded name.
        storedFileName: 'uuid.pdf',
        verifiedBy: null,
      }),
    )
  })

  it('refuses a file whose contents do not match its name, before storing it', async () => {
    const notAPdf = uploadedFile({ buffer: Buffer.from('This is a text file, not a PDF at all.') })

    await expect(
      documentService.uploadFile(5, notAPdf, uploadInput, hr, context),
    ).rejects.toMatchObject({ statusCode: 415 })

    expect(db.storeDocument).not.toHaveBeenCalled()
    expect(db.attachFile).not.toHaveBeenCalled()
  })

  it('refuses an extension that is not on the list', async () => {
    await expect(
      documentService.uploadFile(
        5,
        uploadedFile({ originalname: 'payroll.exe' }),
        uploadInput,
        hr,
        context,
      ),
    ).rejects.toMatchObject({ statusCode: 415 })

    expect(db.storeDocument).not.toHaveBeenCalled()
  })

  it('removes the stored file when the row cannot be saved', async () => {
    db.attachFile.mockRejectedValue(new Error('database is down'))

    await expect(
      documentService.uploadFile(5, uploadedFile(), uploadInput, hr, context),
    ).rejects.toThrow()

    // A row pointing at a file that was never written is a document nobody can
    // open; an orphaned file is only housekeeping.
    expect(db.discardStoredFile).toHaveBeenCalledWith('documents/42/uuid.pdf')
    expect(db.insertAudit).not.toHaveBeenCalled()
  })

  describe('the identity check', () => {
    /** A document type that asks for the two details every form carries. */
    function checkedType() {
      // The reading now happens against the STORED file, so the completion path
      // needs somewhere to read it from.
      db.findStoredFile.mockResolvedValue({
        documentId: 5,
        employeeId: 42,
        storedFileName: 'stored.pdf',
        originalFilePath: 'documents/42/stored.pdf',
        processedFilePath: null,
        originalFileName: 'pan.pdf',
        mimeType: 'application/pdf',
        documentName: 'PAN Card',
        employeeCode: 'EMP007',
      })
      db.readStoredFile.mockResolvedValue(Buffer.from('stored bytes'))
      db.recordIdentityCheck.mockResolvedValue(true)

      db.findDocumentType.mockResolvedValue({
        documentTypeId: 1,
        requiredFields: ['EmployeeName', 'EmployeeCode'],
        recognitionKeywords: [],
      })
      db.findEmployee.mockResolvedValue({
        employeeId: 42,
        employeeCode: 'EMP007',
        employeeName: 'Ravi Kumar',
        joiningDate: '2026-04-01',
        department: null,
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
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      })
    }

    /**
     * The reading no longer happens inside the upload.
     *
     * It used to, and whoever pressed Upload waited for all of it - one measured
     * request sat open for 62 seconds. The file is stored first now and read
     * afterwards, so the upload's job is to answer quickly and say that a
     * reading is under way; the verdict lands on the row a few seconds later.
     */
    it('answers immediately, without reading the document', async () => {
      checkedType()

      await documentService.uploadFile(5, uploadedFile(), uploadInput, hr, context)

      // Stored, and marked as being read. NOT refused, and not waited for.
      expect(db.storeDocument).toHaveBeenCalled()
      expect(db.attachFile).toHaveBeenCalledWith(
        expect.objectContaining({
          identity: expect.objectContaining({ status: 'Checking', overrideBy: null }),
        }),
      )
    })

    it('records what the reading found, once it finishes', async () => {
      checkedType()
      db.extractText.mockResolvedValue({
        text: 'PAN CARD - RAVI KUMAR - EMP 007',
        source: 'PdfText',
        pagesRead: 1,
      })

      await documentService.completeIdentityCheck(5, 'stored.pdf', hr, context)

      expect(db.recordIdentityCheck).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: 5, status: 'Passed', source: 'PdfText' }),
      )
    })

    it('records a refusal against the document, which now exists to record it on', async () => {
      checkedType()
      db.extractText.mockResolvedValue({
        text: 'PAN CARD - ANITA DESAI - EMP113',
        source: 'PdfText',
        pagesRead: 1,
      })

      await documentService.completeIdentityCheck(5, 'stored.pdf', hr, context)

      expect(db.recordIdentityCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'Failed',
          // The sentence HR reads is stored with the row rather than rebuilt on
          // the screen, so it cannot drift from what was actually found. It
          // says what could not be READ, and nothing about whose document this
          // might be - see describeFailure.
          reason: 'Could not read the name from this document. Please confirm manually.',
        }),
      )
      expect(db.insertAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: AUDIT_ACTIONS.DOCUMENT_IDENTITY_REFUSED }),
      )
    })

    it('never leaves the row saying Checking when the reading itself fails', async () => {
      checkedType()
      db.extractText.mockRejectedValue(new Error('the OCR worker died'))

      await documentService.completeIdentityCheck(5, 'stored.pdf', hr, context)

      // The upload already succeeded and the file is safe; all that is lost is
      // the reading. A row stuck on 'Checking' is a spinner nobody can clear.
      expect(db.recordIdentityCheck).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'Failed' }),
      )
    })

    it('does not read a document whose type asks for nothing', async () => {
      await documentService.uploadFile(5, uploadedFile(), uploadInput, hr, context)

      expect(db.extractText).not.toHaveBeenCalled()
      expect(db.attachFile).toHaveBeenCalledWith(
        expect.objectContaining({ identity: expect.objectContaining({ status: 'NotChecked' }) }),
      )
    })
  })

  it('lets HR record a document already held on paper as Verified with no deadline', async () => {
    await documentService.uploadFile(
      5,
      uploadedFile(),
      { isExistingRecord: true, landingStatus: DOCUMENT_STATUS.VERIFIED },
      hr,
      context,
    )

    expect(db.attachFile).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DOCUMENT_STATUS.VERIFIED,
        verifiedBy: 3,
        clearDueDate: true,
      }),
    )
  })

  it('refuses to land a replacement for a verified document straight back as Verified', async () => {
    db.findById.mockResolvedValue(
      record({ status: DOCUMENT_STATUS.VERIFIED, originalFileName: 'old.pdf' }),
    )

    await expect(
      documentService.uploadFile(
        5,
        uploadedFile(),
        { isExistingRecord: false, landingStatus: DOCUMENT_STATUS.VERIFIED },
        hr,
        context,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: API_ERROR_CODES.INVALID_STATE_TRANSITION,
    })
  })

  it('records a replacement as a replacement, not as a first upload', async () => {
    db.findById.mockResolvedValue(record({ originalFileName: 'old.pdf', status: DOCUMENT_STATUS.UPLOADED }))

    await documentService.uploadFile(5, uploadedFile(), uploadInput, hr, context)

    expect(db.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.DOCUMENT_REPLACED }),
    )
  })

  it('starts signature detection again when a signed document is replaced', async () => {
    db.findById.mockResolvedValue(
      record({
        originalFileName: 'old.pdf',
        status: DOCUMENT_STATUS.UPLOADED,
        requiresSignature: true,
        signatureStatus: SIGNATURE_STATUS.ADDED,
      }),
    )

    await documentService.uploadFile(5, uploadedFile(), uploadInput, hr, context)

    // The old placement described a page in a file that is no longer served.
    expect(db.attachFile).toHaveBeenCalledWith(
      expect.objectContaining({ signatureStatus: SIGNATURE_STATUS.PENDING_DETECTION }),
    )
  })

  it('stops a role that may upload but not replace from overwriting a file', async () => {
    db.findById.mockResolvedValue(record({ originalFileName: 'old.pdf', status: DOCUMENT_STATUS.UPLOADED }))

    await expect(
      documentService.uploadFile(5, uploadedFile(), uploadInput, viewer, context),
    ).rejects.toMatchObject({ statusCode: 403 })

    expect(db.storeDocument).not.toHaveBeenCalled()
  })
})

describe('verify', () => {
  it('verifies an uploaded document', async () => {
    db.findById.mockResolvedValue(record({ status: DOCUMENT_STATUS.UPLOADED, originalFileName: 'pan.pdf' }))

    await documentService.verify(5, hr, context)

    expect(db.setStatus).toHaveBeenCalledWith(
      5,
      DOCUMENT_STATUS.UPLOADED,
      DOCUMENT_STATUS.VERIFIED,
      3,
      null,
    )
    expect(db.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.DOCUMENT_VERIFIED }),
    )
  })

  it('refuses to verify a document with no file', async () => {
    db.findById.mockResolvedValue(record({ status: DOCUMENT_STATUS.PENDING }))

    await expect(documentService.verify(5, hr, context)).rejects.toMatchObject({ statusCode: 409 })
    expect(db.setStatus).not.toHaveBeenCalled()
  })

  it('reports a conflict when someone else changed the status first', async () => {
    db.findById.mockResolvedValue(record({ status: DOCUMENT_STATUS.UPLOADED, originalFileName: 'pan.pdf' }))
    // The UPDATE matched no row because Status was no longer what was read.
    db.setStatus.mockResolvedValue(false)

    await expect(documentService.verify(5, hr, context)).rejects.toMatchObject({ statusCode: 409 })
    expect(db.insertAudit).not.toHaveBeenCalled()
  })
})

describe('reject', () => {
  it('rejects an uploaded document with its reason', async () => {
    db.findById.mockResolvedValue(record({ status: DOCUMENT_STATUS.UPLOADED, originalFileName: 'pan.pdf' }))

    await documentService.reject(5, 'The scan is unreadable.', hr, context)

    expect(db.setStatus).toHaveBeenCalledWith(
      5,
      DOCUMENT_STATUS.UPLOADED,
      DOCUMENT_STATUS.REJECTED,
      3,
      'The scan is unreadable.',
    )
  })

  it('refuses to reject a document that was never uploaded', async () => {
    await expect(documentService.reject(5, 'No', hr, context)).rejects.toMatchObject({
      statusCode: 409,
      code: API_ERROR_CODES.INVALID_STATE_TRANSITION,
    })
  })
})

describe('updateDeadline', () => {
  it('records the old and the new date', async () => {
    await documentService.updateDeadline(5, { dueDate: '2026-10-01' }, hr, context)

    expect(db.setDueDate).toHaveBeenCalledWith(5, '2026-10-01')
    const entry = db.insertAudit.mock.calls[0]?.[0]
    expect(entry.action).toBe(AUDIT_ACTIONS.DEADLINE_CHANGED)
    const metadata = JSON.parse(entry.metadataJson ?? '{}') as { from: string; to: string }
    expect(metadata).toMatchObject({ from: '2026-09-11', to: '2026-10-01' })
  })

  it('writes nothing when the date is unchanged', async () => {
    await documentService.updateDeadline(5, { dueDate: '2026-09-11' }, hr, context)

    expect(db.setDueDate).not.toHaveBeenCalled()
    expect(db.insertAudit).not.toHaveBeenCalled()
  })
})

describe('openForDelivery', () => {
  const location = {
    documentId: 5,
    employeeId: 42,
    originalFilePath: 'documents/42/uuid.pdf',
    processedFilePath: null,
    originalFileName: 'whatever-the-user-called-it.pdf',
    mimeType: 'application/pdf',
    documentName: 'PAN Card',
    employeeCode: 'EMP001',
  }

  it('serves the file under a predictable name and audits the view', async () => {
    db.findStoredFile.mockResolvedValue(location)
    db.openStoredFile.mockReturnValue('stream')

    const delivery = await documentService.openForDelivery(5, 'preview', hr, context)

    expect(delivery.fileName).toBe('EMP001 - PAN Card.pdf')
    expect(delivery.mimeType).toBe('application/pdf')
    expect(db.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.DOCUMENT_VIEWED }),
    )
  })

  it('prefers the processed file, so a signed document shows its signature', async () => {
    db.findStoredFile.mockResolvedValue({
      ...location,
      processedFilePath: 'documents/42/uuid-signed.pdf',
    })
    db.openStoredFile.mockReturnValue('stream')

    await documentService.openForDelivery(5, 'download', hr, context)

    expect(db.openStoredFile).toHaveBeenCalledWith('documents/42/uuid-signed.pdf')
    expect(db.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.DOCUMENT_DOWNLOADED }),
    )
  })

  it('says the file is missing from the store rather than reporting "not found"', async () => {
    db.findStoredFile.mockResolvedValue(location)
    db.storedFileExists.mockResolvedValue(false)

    await expect(documentService.openForDelivery(5, 'preview', hr, context)).rejects.toMatchObject({
      statusCode: 409,
    })
  })

  it('404s when nothing has been uploaded yet', async () => {
    db.findStoredFile.mockResolvedValue({ ...location, originalFilePath: null })

    await expect(documentService.openForDelivery(5, 'preview', hr, context)).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})

/**
 * A document this employee is not asked for.
 *
 * ESIC does not apply to everybody, and PF will be next. Nothing here names a
 * document type - the decision is about one row - so the same button works for
 * whichever the office decides on later.
 */
describe('setNotRequired', () => {
  beforeEach(() => {
    db.setNotRequired.mockResolvedValue(true)
  })

  it('marks a document nobody is waiting for, in the actor s own name', async () => {
    await documentService.setNotRequired(5, true, hr, context)

    expect(db.setNotRequired).toHaveBeenCalledWith(5, true, hr.userId)
    expect(db.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.DOCUMENT_MARKED_NOT_REQUIRED }),
    )
  })

  it('puts it back, and records that too', async () => {
    // Undoing is a decision as much as making it: 'why did this reappear' is a
    // question somebody asks months later.
    db.findById.mockResolvedValue(record({ notRequiredAt: '2026-09-10T04:00:00.000Z' }))

    await documentService.setNotRequired(5, false, hr, context)

    expect(db.setNotRequired).toHaveBeenCalledWith(5, false, hr.userId)
    expect(db.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.DOCUMENT_MARKED_REQUIRED }),
    )
  })

  it('refuses a document that has already been received', async () => {
    // The file is in - it was evidently required after all. A row that was both
    // received and not required would be counted differently by different
    // screens depending on which fact each one looked at.
    db.findById.mockResolvedValue(record({ originalFileName: 'esic.pdf' }))

    await expect(documentService.setNotRequired(5, true, hr, context)).rejects.toMatchObject({
      statusCode: 409,
    })
    expect(db.setNotRequired).not.toHaveBeenCalled()
  })

  it('still lets a received document be put BACK to required', async () => {
    // Only marking is blocked by a file. Undoing must always be available, or a
    // decision made by mistake is permanent.
    db.findById.mockResolvedValue(
      record({ originalFileName: 'esic.pdf', notRequiredAt: '2026-09-10T04:00:00.000Z' }),
    )

    await expect(documentService.setNotRequired(5, false, hr, context)).resolves.toBeDefined()
  })

  it('reports a clash rather than overwriting somebody else s decision', async () => {
    db.setNotRequired.mockResolvedValue(false)

    await expect(documentService.setNotRequired(5, true, hr, context)).rejects.toMatchObject({
      statusCode: 409,
    })
  })

  it('is quiet when the row already says what was asked for', async () => {
    // Two people pressing the same button is not a conflict worth an error.
    db.findById.mockResolvedValue(record({ notRequiredAt: '2026-09-10T04:00:00.000Z' }))
    db.setNotRequired.mockResolvedValue(false)

    await expect(documentService.setNotRequired(5, true, hr, context)).resolves.toBeDefined()
  })
})

/**
 * A damaged file leaves the system exactly as it was.
 *
 * The point of catching this at upload rather than later: a rejection must be
 * a non-event. No bytes in the store, no row touched, the document still
 * Pending, nothing to clean up by hand afterwards.
 *
 * What makes it true is the ORDER in uploadFile - the file is inspected before
 * storeDocument is called, so at the moment it is refused nothing has happened
 * yet. These assert that order rather than trusting it.
 */
describe('an upload that is refused as damaged', () => {
  /** A PDF cut off half way. It still begins %PDF-, which is the whole problem. */
  const TRUNCATED_PDF = PDF_BYTES.subarray(0, 12)

  it('writes nothing to the document store', async () => {
    await expect(
      documentService.uploadFile(
        5,
        uploadedFile({ buffer: TRUNCATED_PDF }),
        uploadInput,
        hr,
        context,
      ),
    ).rejects.toThrow()

    expect(db.storeDocument).not.toHaveBeenCalled()
    // Nothing was written, so there is nothing to discard either - a partial
    // file that had to be tidied up would mean the order was wrong.
    expect(db.discardStoredFile).not.toHaveBeenCalled()
  })

  it('changes no row, so the document stays Pending', async () => {
    await expect(
      documentService.uploadFile(
        5,
        uploadedFile({ buffer: TRUNCATED_PDF }),
        uploadInput,
        hr,
        context,
      ),
    ).rejects.toThrow()

    expect(db.attachFile).not.toHaveBeenCalled()
    expect(db.setStatus).not.toHaveBeenCalled()
  })

  it('records nothing in the audit trail, because nothing happened', async () => {
    await expect(
      documentService.uploadFile(
        5,
        uploadedFile({ buffer: TRUNCATED_PDF }),
        uploadInput,
        hr,
        context,
      ),
    ).rejects.toThrow()

    expect(db.insertAudit).not.toHaveBeenCalled()
  })

  it('tells HR the file is damaged rather than reporting a server fault', async () => {
    await expect(
      documentService.uploadFile(
        5,
        uploadedFile({ buffer: TRUNCATED_PDF }),
        uploadInput,
        hr,
        context,
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})
