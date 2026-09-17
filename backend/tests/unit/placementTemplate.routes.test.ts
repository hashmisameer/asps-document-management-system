import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROLES, type Role } from '@asps-dms/shared'

/**
 * Placement templates over HTTP, with the database mocked.
 *
 * What is asserted is the boundary: only an administrator may read or write
 * a template - HR, who signs documents all day, may not; a photograph box is
 * refused at save time on any type but the ESIC form, in the stamper's own
 * words; the scanned cards have no template; and saving reaches the template
 * repository and nothing else.
 */

const db = vi.hoisted(() => ({
  findByTokenHash: vi.fn(),
  touchSession: vi.fn(),
  findDocumentType: vi.fn(),
  listForType: vi.fn(),
  replaceForType: vi.fn(),
  summaries: vi.fn(),
  replacePlacements: vi.fn(),
  setProcessedFile: vi.fn(),
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

vi.mock('../../src/repositories/documentType.repository.js', () => ({
  findById: db.findDocumentType,
  listActive: vi.fn(),
  listAll: vi.fn(),
}))

vi.mock('../../src/repositories/documentTypePlacement.repository.js', () => ({
  listForType: db.listForType,
  replaceForType: db.replaceForType,
  summaries: db.summaries,
}))

// The document side, which a template must never reach.
vi.mock('../../src/repositories/signaturePlacement.repository.js', () => ({
  listForDocument: vi.fn(),
  replaceForDocument: db.replacePlacements,
  markApplied: vi.fn(),
}))
vi.mock('../../src/repositories/employeeDocument.repository.js', () => ({
  findById: vi.fn(),
  findStoredFile: vi.fn(),
  setProcessedFile: db.setProcessedFile,
  listForEmployee: vi.fn(),
  createChecklist: vi.fn(),
  listDocumentTypeIdsForEmployee: vi.fn(),
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
    userId: 9,
    issuedAt: new Date(now - 60_000),
    lastSeenAt: new Date(now - 5_000),
    expiresAt: new Date(now + 60 * 60_000),
    absoluteExpiry: new Date(now + 12 * 60 * 60_000),
    revokedAt: null,
    username: 'someone',
    fullName: 'Some One',
    role,
    isActive: true,
    mustChangePassword: false,
  })
  return [`${COOKIE_NAME}=${TOKEN}`]
}

const type = (code: string, name: string) => ({
  documentTypeId: 6,
  documentName: name,
  documentCode: code,
  isActive: true,
  isMandatory: false,
  requiresSignature: true,
})

const BOX = {
  pageNumber: 1,
  x: 0.6,
  y: 0.8,
  width: 0.28,
  height: 0.09,
  pageRotation: 0,
  pageWidthPt: 595.28,
  pageHeightPt: 841.89,
}

const body = (placements: object[]) => ({ sampleDocumentId: 96, samplePageCount: 1, placements })

beforeEach(() => {
  vi.clearAllMocks()
  db.touchSession.mockResolvedValue(undefined)
  db.insertAudit.mockResolvedValue(undefined)
  db.findDocumentType.mockResolvedValue(type('ESIC_FORM', 'ESIC Form'))
  db.listForType.mockResolvedValue([])
  db.replaceForType.mockResolvedValue(undefined)
  db.summaries.mockResolvedValue([])
})

describe('who may touch a template', () => {
  it('lets an administrator list, read and save', async () => {
    const admin = signedInAs(ROLES.ADMIN)
    expect((await request(app).get('/api/document-types/placements').set('Cookie', admin)).status).toBe(200)
    expect((await request(app).get('/api/document-types/6/placements').set('Cookie', admin)).status).toBe(200)
    const saved = await request(app)
      .put('/api/document-types/6/placements')
      .set('Cookie', admin)
      .send(body([{ ...BOX, signerRole: 'Employee' }]))
    expect(saved.status).toBe(200)
  })

  it('refuses HR on all three - set once, wrong for everybody if wrong once', async () => {
    const hr = signedInAs(ROLES.HR)
    expect((await request(app).get('/api/document-types/placements').set('Cookie', hr)).status).toBe(403)
    expect((await request(app).get('/api/document-types/6/placements').set('Cookie', hr)).status).toBe(403)
    const saved = await request(app)
      .put('/api/document-types/6/placements')
      .set('Cookie', hr)
      .send(body([{ ...BOX, signerRole: 'Employee' }]))
    expect(saved.status).toBe(403)
    expect(db.replaceForType).not.toHaveBeenCalled()
  })

  it('reads /document-types/placements as a route, not as a type id', async () => {
    db.summaries.mockResolvedValue([{ documentTypeId: 1, documentCode: 'X', status: 'unset' }])
    const response = await request(app).get('/api/document-types/placements').set('Cookie', signedInAs(ROLES.ADMIN))
    expect(response.status).toBe(200)
    expect(response.body.templates).toHaveLength(1)
    expect(db.findDocumentType).not.toHaveBeenCalled()
  })
})

describe('saving a template', () => {
  it('records the boxes against the type with the sample they were drawn on', async () => {
    const response = await request(app)
      .put('/api/document-types/6/placements')
      .set('Cookie', signedInAs(ROLES.ADMIN))
      .send(
        body([
          { ...BOX, signerRole: 'Employee' },
          { ...BOX, signerRole: 'Authoriser', y: 0.6 },
          { ...BOX, signerRole: 'Photo', x: 0.76, y: 0.06, width: 0.16, height: 0.14 },
        ]),
      )

    expect(response.status).toBe(200)
    expect(db.replaceForType).toHaveBeenCalledWith(
      6,
      expect.arrayContaining([
        expect.objectContaining({ signerRole: 'Employee', pageWidthPt: 595.28 }),
        expect.objectContaining({ signerRole: 'Photo' }),
      ]),
      { documentId: 96, pageCount: 1 },
      9,
    )
  })

  it('never writes a document placement, a processed file, or a document row', async () => {
    await request(app)
      .put('/api/document-types/6/placements')
      .set('Cookie', signedInAs(ROLES.ADMIN))
      .send(body([{ ...BOX, signerRole: 'Employee' }]))

    expect(db.replacePlacements).not.toHaveBeenCalled()
    expect(db.setProcessedFile).not.toHaveBeenCalled()
  })

  it('refuses a photograph box on any type but the ESIC form, in the stamper’s words', async () => {
    db.findDocumentType.mockResolvedValue(type('GRATUITY_FORM', 'Payment of Gratuity'))

    const response = await request(app)
      .put('/api/document-types/6/placements')
      .set('Cookie', signedInAs(ROLES.ADMIN))
      .send(body([{ ...BOX, signerRole: 'Employee' }, { ...BOX, signerRole: 'Photo' }]))

    expect(response.status).toBe(409)
    expect(response.body.error.message).toBe(
      'A photograph can be placed on the ESIC form only, not on Payment of Gratuity.',
    )
    expect(db.replaceForType).not.toHaveBeenCalled()
  })

  it('refuses a template for a scanned identity card', async () => {
    db.findDocumentType.mockResolvedValue(type('AADHAAR_CARD', 'Aadhaar Card'))

    const response = await request(app)
      .put('/api/document-types/6/placements')
      .set('Cookie', signedInAs(ROLES.ADMIN))
      .send(body([{ ...BOX, signerRole: 'Employee' }]))

    expect(response.status).toBe(409)
    expect(response.body.error.message).toContain('scanned card')
    expect(db.replaceForType).not.toHaveBeenCalled()
  })

  it('refuses boxes drawn on pages of different sizes - two samples, not one', async () => {
    const response = await request(app)
      .put('/api/document-types/6/placements')
      .set('Cookie', signedInAs(ROLES.ADMIN))
      .send(
        body([
          { ...BOX, signerRole: 'Employee' },
          { ...BOX, signerRole: 'Authoriser', y: 0.6, pageWidthPt: 612, pageHeightPt: 792 },
        ]),
      )

    expect(response.status).toBe(400)
    expect(db.replaceForType).not.toHaveBeenCalled()
  })

  it('refuses a box on a page the sample does not have', async () => {
    const response = await request(app)
      .put('/api/document-types/6/placements')
      .set('Cookie', signedInAs(ROLES.ADMIN))
      .send({ ...body([{ ...BOX, signerRole: 'Employee', pageNumber: 3 }]), samplePageCount: 2 })

    expect(response.status).toBe(400)
    expect(db.replaceForType).not.toHaveBeenCalled()
  })

  it('answers 404 for a type that does not exist, and 409 for a retired one', async () => {
    db.findDocumentType.mockResolvedValue(null)
    expect(
      (
        await request(app)
          .put('/api/document-types/6/placements')
          .set('Cookie', signedInAs(ROLES.ADMIN))
          .send(body([]))
      ).status,
    ).toBe(404)

    db.findDocumentType.mockResolvedValue({ ...type('SERVICE_CARD', 'Service Card'), isActive: false })
    expect(
      (
        await request(app)
          .put('/api/document-types/6/placements')
          .set('Cookie', signedInAs(ROLES.ADMIN))
          .send(body([]))
      ).status,
    ).toBe(409)
  })

  it('removes the template when given no boxes', async () => {
    const response = await request(app)
      .put('/api/document-types/6/placements')
      .set('Cookie', signedInAs(ROLES.ADMIN))
      .send(body([]))

    expect(response.status).toBe(200)
    expect(db.replaceForType).toHaveBeenCalledWith(6, [], { documentId: 96, pageCount: 1 }, 9)
  })
})
