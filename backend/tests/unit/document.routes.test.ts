import { PDFDocument, StandardFonts } from 'pdf-lib'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCUMENT_STATUS, ROLES, SIGNATURE_STATUS, type Role } from '@asps-dms/shared'

/**
 * The document routes over HTTP, with the database and the store mocked.
 *
 * The point of interest is the preview/download split: a Viewer may look at a
 * document and may not take a copy of it (open question Q6). That distinction
 * exists only because they are two permissions on two routes, so it is worth a
 * test that would notice if they were ever collapsed into one.
 */

const db = vi.hoisted(() => ({
  findByTokenHash: vi.fn(),
  touchSession: vi.fn(),
  findById: vi.fn(),
  findStoredFile: vi.fn(),
  attachFile: vi.fn(),
  setStatus: vi.fn(),
  setDueDate: vi.fn(),
  insertAudit: vi.fn(),
  storeDocument: vi.fn(),
  openStoredFile: vi.fn(),
  storedFileExists: vi.fn(),
  discardStoredFile: vi.fn(),
  findDocumentType: vi.fn(),
  findEmployee: vi.fn(),
  readStoredFile: vi.fn(),
  assessBoxes: vi.fn(),
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
  findById: db.findById,
  findStoredFile: db.findStoredFile,
  attachFile: db.attachFile,
  setStatus: db.setStatus,
  setDueDate: db.setDueDate,
  listForEmployee: vi.fn(),
  createChecklist: vi.fn(),
  listDocumentTypeIdsForEmployee: vi.fn(),
}))

vi.mock('../../src/services/storage.service.js', () => ({
  storeDocument: db.storeDocument,
  discardStoredFile: db.discardStoredFile,
  openStoredFile: db.openStoredFile,
  readStoredFile: db.readStoredFile,
  storedFileExists: db.storedFileExists,
  ensureStorageReady: vi.fn(),
  checkStorageWritable: vi.fn().mockResolvedValue({ ok: true }),
  resolveWithinRoot: vi.fn(),
}))

vi.mock('../../src/repositories/audit.repository.js', () => ({ insert: db.insertAudit }))

// The occupancy check is tested against real PDFs elsewhere; here it answers
// whatever the test says, so these tests are about who may ask and what comes back.
vi.mock('../../src/services/boxOccupancy.service.js', () => ({ assessBoxes: db.assessBoxes }))

// The identity check's two reads. A document type that asks for no fields is
// the uninteresting answer, which keeps these tests about routing.
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

const { createApp } = await import('../../src/app.js')
const { Readable } = await import('node:stream')
const app = createApp()

const COOKIE_NAME = 'asps_dms_sid'

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
  return [`${COOKIE_NAME}=${'a'.repeat(64)}`]
}

/**
 * A real PDF, built rather than hand-written.
 *
 * It used to be a few literal bytes beginning '%PDF-', which was enough while
 * the upload only read the first few. The file is opened now and asked how
 * many pages it has, and those bytes were never a PDF that would open - the
 * fixture would have been refused exactly as a truncated upload is.
 */
async function realPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([595.28, 841.89]).drawText('PAN CARD', { x: 60, y: 700, font, size: 18 })
  return Buffer.from(await pdf.save())
}

const PDF_BYTES = await realPdf()

const documentRecord = {
  documentId: 5,
  employeeId: 42,
  employeeCode: 'EMP001',
  employeeName: 'Ravi Kumar',
  documentTypeId: 1,
  documentName: 'PAN Card',
  isMandatory: true,
  requiresSignature: false,
  originalFileName: 'pan.pdf',
  fileSizeBytes: 1024,
  mimeType: 'application/pdf',
  pageCount: null,
  hasProcessedFile: false,
  status: DOCUMENT_STATUS.UPLOADED,
  signatureStatus: SIGNATURE_STATUS.NOT_REQUIRED,
  dueDate: '2026-09-11',
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
  originalFilePath: 'documents/42/uuid.pdf',
  processedFilePath: null,
  originalFileName: 'pan.pdf',
  mimeType: 'application/pdf',
  documentName: 'PAN Card',
  employeeCode: 'EMP001',
}

beforeEach(() => {
  vi.clearAllMocks()
  db.insertAudit.mockResolvedValue(undefined)
  db.touchSession.mockResolvedValue(undefined)
  db.findById.mockResolvedValue(documentRecord)
  db.findDocumentType.mockResolvedValue({
    documentTypeId: 1,
    documentName: 'Test Document',
    requiredFields: [],
    recognitionKeywords: [],
  })
  db.findEmployee.mockResolvedValue(null)
  db.findStoredFile.mockResolvedValue(storedFile)
  db.storedFileExists.mockResolvedValue(true)
  db.setStatus.mockResolvedValue(true)
  db.attachFile.mockResolvedValue(undefined)
  db.openStoredFile.mockImplementation(() => Readable.from([PDF_BYTES]))
  db.storeDocument.mockResolvedValue({
    storedFileName: 'uuid.pdf',
    relativePath: 'documents/42/uuid.pdf',
    sizeBytes: PDF_BYTES.byteLength,
    sha256: Buffer.alloc(32, 1),
  })
})

describe('serving a document', () => {
  it('lets a Viewer preview a document, inline and uncacheable', async () => {
    const response = await request(app)
      .get('/api/documents/5/preview')
      .set('Cookie', signedInAs(ROLES.VIEWER))

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('application/pdf')
    expect(response.headers['content-disposition']).toContain('inline')
    expect(response.headers['content-disposition']).toContain('EMP001 - PAN Card.pdf')
    // An employee's document must not sit in a shared cache.
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })

  it('lets a Viewer download it too - Management sees, downloads and prints everything', async () => {
    const response = await request(app)
      .get('/api/documents/5/download')
      .set('Cookie', signedInAs(ROLES.VIEWER))

    expect(response.status).toBe(200)
    expect(response.headers['content-disposition']).toContain('attachment')
  })

  it('lets HR download it as an attachment', async () => {
    const response = await request(app)
      .get('/api/documents/5/download')
      .set('Cookie', signedInAs(ROLES.HR))

    expect(response.status).toBe(200)
    expect(response.headers['content-disposition']).toContain('attachment')
  })

  it('refuses to serve anything without a session', async () => {
    const response = await request(app).get('/api/documents/5/preview')

    expect(response.status).toBe(401)
    expect(db.findStoredFile).not.toHaveBeenCalled()
  })

  it('never reveals where the file is on disk', async () => {
    db.storedFileExists.mockResolvedValue(false)

    const response = await request(app)
      .get('/api/documents/5/preview')
      .set('Cookie', signedInAs(ROLES.HR))

    expect(response.status).toBe(409)
    expect(JSON.stringify(response.body)).not.toContain('documents/42')
  })
})

describe('uploading', () => {
  it('accepts a PDF from HR and returns the updated document', async () => {
    db.findById
      .mockResolvedValueOnce({
        ...documentRecord,
        status: DOCUMENT_STATUS.PENDING,
        originalFileName: null,
      })
      .mockResolvedValue(documentRecord)

    const response = await request(app)
      .post('/api/documents/5/file')
      .set('Cookie', signedInAs(ROLES.HR))
      .attach('file', PDF_BYTES, 'pan-card.pdf')

    expect(response.status).toBe(200)
    expect(response.body.document.documentId).toBe(5)
    expect(db.attachFile).toHaveBeenCalled()
  })

  it('stops a Viewer uploading', async () => {
    const response = await request(app)
      .post('/api/documents/5/file')
      .set('Cookie', signedInAs(ROLES.VIEWER))
      .attach('file', PDF_BYTES, 'pan-card.pdf')

    expect(response.status).toBe(403)
    expect(db.storeDocument).not.toHaveBeenCalled()
  })

  it('says which field to use when no file is attached', async () => {
    const response = await request(app)
      .post('/api/documents/5/file')
      .set('Cookie', signedInAs(ROLES.HR))
      .field('isExistingRecord', 'false')

    expect(response.status).toBe(400)
    expect(response.body.error.message).toContain('file')
  })

  it("reads 'false' from a form field as false", async () => {
    db.findById
      .mockResolvedValueOnce({
        ...documentRecord,
        status: DOCUMENT_STATUS.PENDING,
        originalFileName: null,
      })
      .mockResolvedValue(documentRecord)

    await request(app)
      .post('/api/documents/5/file')
      .set('Cookie', signedInAs(ROLES.HR))
      .field('isExistingRecord', 'false')
      .attach('file', PDF_BYTES, 'pan-card.pdf')

    expect(db.attachFile).toHaveBeenCalledWith(expect.objectContaining({ clearDueDate: false }))
  })
})

describe('asking whether a box is already taken', () => {
  const box = {
    pageNumber: 1,
    x: 0.1,
    y: 0.8,
    width: 0.2,
    height: 0.08,
    pageRotation: 0,
    method: 'Manual',
    detectionMethod: 'Manual',
  }

  beforeEach(() => {
    db.readStoredFile.mockResolvedValue(PDF_BYTES)
    db.assessBoxes.mockResolvedValue([
      {
        label: '0',
        signerRole: 'Employee',
        pageNumber: 1,
        rect: { x: 0.1, y: 0.8, width: 0.2, height: 0.08 },
        verdict: 'occupied',
        decidedBy: 'image',
        pageKind: 'digital',
        overlap: { images: 1, coverage: 0.97 },
        reason: 'an image covers 97% of the box',
      },
    ])
  })

  it('answers HR, box by box, without changing anything', async () => {
    const response = await request(app)
      .post('/api/documents/5/placements/check')
      .set('Cookie', signedInAs(ROLES.HR))
      .send({ placements: [box] })

    expect(response.status).toBe(200)
    expect(response.body.occupancy).toEqual([
      expect.objectContaining({
        index: 0,
        signerRole: 'Employee',
        pageNumber: 1,
        verdict: 'occupied',
        decidedBy: 'image',
        overlap: { images: 1, coverage: 0.97 },
      }),
    ])
    // The ORIGINAL was read, and nothing was written or recorded.
    expect(db.readStoredFile).toHaveBeenCalledWith('documents/42/uuid.pdf')
    expect(db.insertAudit).not.toHaveBeenCalled()
    expect(db.setStatus).not.toHaveBeenCalled()
  })

  it('stops a Viewer asking: the answer only matters to someone who can stamp', async () => {
    const response = await request(app)
      .post('/api/documents/5/placements/check')
      .set('Cookie', signedInAs(ROLES.VIEWER))
      .send({ placements: [box] })

    expect(response.status).toBe(403)
    expect(db.assessBoxes).not.toHaveBeenCalled()
  })

  it('refuses a box that is not a box', async () => {
    const response = await request(app)
      .post('/api/documents/5/placements/check')
      .set('Cookie', signedInAs(ROLES.HR))
      .send({ placements: [{ ...box, width: 0 }] })

    expect(response.status).toBe(400)
    expect(db.assessBoxes).not.toHaveBeenCalled()
  })
})

describe('verify and reject', () => {
  it('lets HR verify', async () => {
    const response = await request(app)
      .post('/api/documents/5/verify')
      .set('Cookie', signedInAs(ROLES.HR))

    expect(response.status).toBe(200)
    expect(db.setStatus).toHaveBeenCalled()
  })

  it('stops a Viewer verifying', async () => {
    const response = await request(app)
      .post('/api/documents/5/verify')
      .set('Cookie', signedInAs(ROLES.VIEWER))

    expect(response.status).toBe(403)
    expect(db.setStatus).not.toHaveBeenCalled()
  })

  it('requires a reason to reject', async () => {
    const response = await request(app)
      .post('/api/documents/5/reject')
      .set('Cookie', signedInAs(ROLES.HR))
      .send({ reason: '   ' })

    expect(response.status).toBe(400)
    expect(db.setStatus).not.toHaveBeenCalled()
  })
})
