import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SIGNATURE_STATUS,
  SIGNER_ROLES,
  STAMP_OUTCOMES,
  addDays,
  todayDateOnly,
  type EmployeeDocument,
} from '@asps-dms/shared'
import { env } from '../../src/config/env.js'
import { createRequest } from '../../src/database/pool.js'
import * as documentTypePlacementRepository from '../../src/repositories/documentTypePlacement.repository.js'
import * as documentTypeRepository from '../../src/repositories/documentType.repository.js'
import * as employeeDocumentRepository from '../../src/repositories/employeeDocument.repository.js'
import { run, runBacklog } from '../../src/services/autoStampRun.service.js'
import { app, closeDatabase, createUser, ensureSchema, resetData, signIn } from './helpers.js'

/**
 * Stamping on upload, end to end: a template on a real type, a real PDF
 * uploaded over HTTP, the identity check reading it, the decision recorded in
 * the real table, and - in stamp mode - a signed copy actually made.
 *
 * The rules are pinned in the unit tests. What only the database can prove is
 * that the pieces are wired: the upload hands over, the decision row lands,
 * the checklist reads it back, the placement rows say 'Template', and the
 * status leaves PendingDetection whatever happens.
 */

/** A one-page A4 appointment letter with a text layer the identity check can read. */
async function letterFor(name: string, code: string, joining: string): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595.28, 841.89])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText('ASPS INTERNATIONAL - APPOINTMENT LETTER', { x: 50, y: 780, size: 14, font })
  page.drawText(`Name: ${name}`, { x: 50, y: 740, size: 12, font })
  page.drawText(`Employee Code: ${code}`, { x: 50, y: 720, size: 12, font })
  page.drawText(`Date of Joining: ${joining}`, { x: 50, y: 700, size: 12, font })
  return Buffer.from(await pdf.save())
}

/** A signature: a stroke on a transparent background. */
function signaturePng(): Buffer {
  const canvas = createCanvas(400, 160)
  const ctx = canvas.getContext('2d')
  ctx.strokeStyle = '#1a1a6e'
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.moveTo(30, 110)
  ctx.bezierCurveTo(120, 20, 200, 150, 370, 60)
  ctx.stroke()
  return canvas.toBuffer('image/png')
}

/** The document once its background work has finished, or the last thing seen. */
async function settled(
  agent: Awaited<ReturnType<typeof signIn>>,
  documentId: number,
): Promise<EmployeeDocument> {
  let last: EmployeeDocument | null = null
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await agent.get(`/api/documents/${documentId}`)
    last = response.body.document as EmployeeDocument
    if (
      last.signatureStatus !== SIGNATURE_STATUS.PENDING_DETECTION &&
      last.identityCheck?.status !== 'Checking'
    ) {
      return last
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!last) throw new Error('the document never answered')
  return last
}

const JOINED = addDays(todayDateOnly(), -3)
const JOINED_ON_PAPER = JOINED.split('-').reverse().join('/')
const A4 = { pageCount: 1, widthPt: 595, heightPt: 842 }
const BOX = {
  pageNumber: 1,
  width: 0.28,
  height: 0.09,
  pageRotation: 0,
  pageWidthPt: 595.28,
  pageHeightPt: 841.89,
}

let codeSeq = 0

describe('stamping on upload, end to end', () => {
  let adminUserId = 0
  let letterTypeId = 0
  const originalMode = env.AUTO_STAMP
  const originalTypes = env.AUTO_STAMP_TYPES

  beforeAll(async () => {
    await ensureSchema()
    await resetData()

    const admin = await createUser('admin.autostamp', 'ADMIN')
    adminUserId = admin.userId

    const types = await documentTypeRepository.listActive()
    letterTypeId = types.find((t) => t.documentCode === 'APPOINTMENT_LETTER')?.documentTypeId ?? 0
    expect(letterTypeId).toBeGreaterThan(0)

    // The template: an employee box and an HR box on the one-page A4 letter.
    await documentTypePlacementRepository.replaceForVariant(
      letterTypeId,
      A4,
      [
        { ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, x: 0.1, y: 0.85 },
        { ...BOX, signerRole: SIGNER_ROLES.AUTHORISER, x: 0.6, y: 0.85 },
      ],
      null,
      adminUserId,
    )
  })

  afterAll(async () => {
    ;(env as { AUTO_STAMP: string }).AUTO_STAMP = originalMode
    ;(env as { AUTO_STAMP_TYPES: ReadonlySet<string> }).AUTO_STAMP_TYPES = originalTypes
    await closeDatabase()
  })

  /** An employee with a signature on file, and their appointment letter row. */
  async function employeeWithSignature(agent: Awaited<ReturnType<typeof signIn>>) {
    const created = await agent.post('/api/employees').send({
      employeeCode: `AS${++codeSeq}`,
      employeeName: 'Ravi Kumar',
      joiningDate: JOINED,
    })
    expect(created.status).toBe(201)
    const employee = created.body.employee

    const enrolled = await agent
      .post(`/api/employees/${employee.employeeId}/signature`)
      .attach('file', signaturePng(), { filename: 'sig.png', contentType: 'image/png' })
    expect(enrolled.status).toBe(200)

    const checklist = await agent.get(`/api/employees/${employee.employeeId}/documents`)
    const letter = checklist.body.documents.find(
      (d: { documentCode: string }) => d.documentCode === 'APPOINTMENT_LETTER',
    )
    return { employee, letter }
  }

  it('in report mode: records what it would have stamped, stamps nothing, and HR sees why', async () => {
    ;(env as { AUTO_STAMP: string }).AUTO_STAMP = 'report'
    const agent = await signIn(app(), await createUser('hr.report', 'HR'))
    const { employee, letter } = await employeeWithSignature(agent)

    const upload = await agent
      .post(`/api/documents/${letter.documentId}/file`)
      .attach('file', await letterFor('Ravi Kumar', employee.employeeCode, JOINED_ON_PAPER), {
        filename: 'letter.pdf',
        contentType: 'application/pdf',
      })
    expect(upload.status).toBe(200)
    expect(upload.body.document.signatureStatus).toBe(SIGNATURE_STATUS.PENDING_DETECTION)

    const document = await settled(agent, letter.documentId)

    // Out of PendingDetection, and to HR - nothing was stamped.
    expect(document.signatureStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
    expect(document.hasProcessedFile).toBe(false)

    // The decision is on the row, in the words HR reads. The uploader (HR)
    // has no signature of their own, so the HR box would have been left.
    expect(document.stampDecision).toMatchObject({
      mode: 'Report',
      outcome: STAMP_OUTCOMES.PARTIAL,
      stampedCount: 1,
      skippedCount: 1,
    })
    expect(document.stampDecision?.summary).toBe(
      'Stamped: employee signature. Not stamped: the hr signature - the person who uploaded it has no signature on file.',
    )
    expect(document.stampDecision?.boxes.map((box) => [box.signerRole, box.action])).toEqual([
      ['Employee', 'stamp'],
      ['Authoriser', 'skip'],
    ])

    // And no placement row: report mode writes the decision and nothing else.
    const request = await createRequest()
    const placements = await request.query<{ N: number }>(
      `SELECT COUNT(*) AS N FROM dbo.SignaturePlacements WHERE DocumentId = ${letter.documentId}`,
    )
    expect(placements.recordset[0]?.N).toBe(0)
  })

  it('in stamp mode: stamps both boxes from the template and the document is signed', async () => {
    ;(env as { AUTO_STAMP: string }).AUTO_STAMP = 'stamp'
    const hr = await createUser('hr.stamp', 'HR')
    const agent = await signIn(app(), hr)

    // The uploader's own signature, so the HR box has something to carry.
    const mine = await agent
      .post('/api/me/signature')
      .field('capture', 'Uploaded')
      .attach('file', signaturePng(), { filename: 'mine.png', contentType: 'image/png' })
    expect(mine.status).toBe(200)

    const { employee, letter } = await employeeWithSignature(agent)

    const upload = await agent
      .post(`/api/documents/${letter.documentId}/file`)
      .attach('file', await letterFor('Ravi Kumar', employee.employeeCode, JOINED_ON_PAPER), {
        filename: 'letter.pdf',
        contentType: 'application/pdf',
      })
    expect(upload.status).toBe(200)

    const document = await settled(agent, letter.documentId)

    expect(document.signatureStatus).toBe(SIGNATURE_STATUS.ADDED)
    expect(document.hasProcessedFile).toBe(true)
    expect(document.stampDecision).toMatchObject({
      mode: 'Stamp',
      outcome: STAMP_OUTCOMES.STAMPED,
      stampedCount: 2,
      skippedCount: 0,
    })

    // The placements say where they came from, and who the authoriser was.
    const request = await createRequest()
    const rows = await request.query<{
      SignerRole: string
      Method: string
      DetectionMethod: string
      SignerUserId: number | null
      IsApplied: boolean
    }>(
      `SELECT SignerRole, Method, DetectionMethod, SignerUserId, IsApplied
       FROM dbo.SignaturePlacements WHERE DocumentId = ${letter.documentId} ORDER BY SignerRole`,
    )
    expect(rows.recordset).toEqual([
      {
        SignerRole: 'Authoriser',
        Method: 'Automatic',
        DetectionMethod: 'Template',
        SignerUserId: hr.userId,
        IsApplied: true,
      },
      {
        SignerRole: 'Employee',
        Method: 'Automatic',
        DetectionMethod: 'Template',
        SignerUserId: null,
        IsApplied: true,
      },
    ])

    // The signed copy is what is served.
    const served = await agent.get(`/api/documents/${letter.documentId}/preview`)
    expect(served.status).toBe(200)
    expect(served.headers['content-type']).toContain('application/pdf')
  })

  it('leaves a type that is not in the auto-stamp list for HR, and stamps nothing on it', async () => {
    ;(env as { AUTO_STAMP: string }).AUTO_STAMP = 'stamp'
    ;(env as { AUTO_STAMP_TYPES: ReadonlySet<string> }).AUTO_STAMP_TYPES = new Set(['ESIC_FORM'])
    try {
      const hr = await createUser('hr.notlisted', 'HR')
      const agent = await signIn(app(), hr)
      const mine = await agent
        .post('/api/me/signature')
        .field('capture', 'Uploaded')
        .attach('file', signaturePng(), { filename: 'mine.png', contentType: 'image/png' })
      expect(mine.status).toBe(200)
      const { employee, letter } = await employeeWithSignature(agent)

      // Everything a stamp needs is there - the template, both signatures,
      // stamp mode - and the type is not in the list, so nothing goes on.
      const upload = await agent
        .post(`/api/documents/${letter.documentId}/file`)
        .attach('file', await letterFor('Ravi Kumar', employee.employeeCode, JOINED_ON_PAPER), {
          filename: 'letter.pdf',
          contentType: 'application/pdf',
        })
      expect(upload.status).toBe(200)

      const document = await settled(agent, letter.documentId)

      expect(document.signatureStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
      expect(document.hasProcessedFile).toBe(false)
      expect(document.stampDecision).toMatchObject({
        mode: 'Stamp',
        outcome: STAMP_OUTCOMES.NOT_IN_LIST,
        stampedCount: 0,
        skippedCount: 0,
        boxes: [],
      })
      expect(document.stampDecision?.summary).toBe(
        'Not stamped: Appointment Letter is not in the auto-stamp list.',
      )

      const request = await createRequest()
      const placements = await request.query<{ N: number }>(
        `SELECT COUNT(*) AS N FROM dbo.SignaturePlacements WHERE DocumentId = ${letter.documentId}`,
      )
      expect(placements.recordset[0]?.N).toBe(0)

      // The watcher's re-decide would find the same document waiting; a second
      // run records nothing new.
      const decisions = await request.query<{ N: number }>(
        `SELECT COUNT(*) AS N FROM dbo.StampDecisions WHERE DocumentId = ${letter.documentId}`,
      )
      expect(decisions.recordset[0]?.N).toBe(1)
      await run(
        letter.documentId,
        {
          userId: hr.userId,
          username: hr.username,
          fullName: 'HR',
          role: 'HR',
          mustChangePassword: false,
        },
        { ipAddress: null, userAgent: 'test' },
      )
      const again = await request.query<{ N: number }>(
        `SELECT COUNT(*) AS N FROM dbo.StampDecisions WHERE DocumentId = ${letter.documentId}`,
      )
      expect(again.recordset[0]?.N).toBe(1)
    } finally {
      ;(env as { AUTO_STAMP_TYPES: ReadonlySet<string> }).AUTO_STAMP_TYPES = originalTypes
    }
  })

  it('leaves a scan alone: not a PDF, so no template can match it', async () => {
    ;(env as { AUTO_STAMP: string }).AUTO_STAMP = 'stamp'
    const agent = await signIn(app(), await createUser('hr.scan', 'HR'))
    const { letter } = await employeeWithSignature(agent)

    const scan = createCanvas(1200, 1700)
    const ctx = scan.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, 1200, 1700)
    ctx.fillStyle = '#000'
    ctx.font = '28px Arial'
    ctx.fillText('APPOINTMENT LETTER', 100, 120)

    const upload = await agent
      .post(`/api/documents/${letter.documentId}/file`)
      .field('identityOverrideReason', 'A scan; confirmed by hand')
      .attach('file', scan.toBuffer('image/jpeg'), {
        filename: 'letter.jpg',
        contentType: 'image/jpeg',
      })
    expect(upload.status).toBe(200)

    const document = await settled(agent, letter.documentId)

    expect(document.signatureStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
    expect(document.hasProcessedFile).toBe(false)
    expect(document.stampDecision?.outcome).toBe(STAMP_OUTCOMES.NOT_PDF)
    expect(document.stampDecision?.summary).toBe(
      'Not stamped: the file is not a PDF; templates are for the generated forms.',
    )
  })

  it('the backlog: a document stuck in PendingDetection is decided about, in its uploader’s name', async () => {
    ;(env as { AUTO_STAMP: string }).AUTO_STAMP = 'report'
    const hr = await createUser('hr.backlog', 'HR')
    const agent = await signIn(app(), hr)
    const { employee, letter } = await employeeWithSignature(agent)

    const upload = await agent
      .post(`/api/documents/${letter.documentId}/file`)
      .attach('file', await letterFor('Ravi Kumar', employee.employeeCode, JOINED_ON_PAPER), {
        filename: 'letter.pdf',
        contentType: 'application/pdf',
      })
    expect(upload.status).toBe(200)
    await settled(agent, letter.documentId)

    // Put it back where every document sat before stamping on upload existed.
    const request = await createRequest()
    await request.query(
      `UPDATE dbo.EmployeeDocuments SET SignatureStatus = 'PendingDetection' WHERE DocumentId = ${letter.documentId}`,
    )
    const waiting = await employeeDocumentRepository.listSignatureBacklog(100)
    expect(waiting.map((row) => row.documentId)).toContain(letter.documentId)
    expect(waiting.find((row) => row.documentId === letter.documentId)?.uploadedBy).toBe(hr.userId)

    const admin = await createUser('admin.backlog', 'ADMIN')
    const outcomes = await runBacklog(
      waiting.filter((row) => row.documentId === letter.documentId),
      {
        fallback: {
          userId: admin.userId,
          username: admin.username,
          fullName: 'Admin',
          role: 'ADMIN',
          mustChangePassword: false,
        },
        context: { ipAddress: null, userAgent: 'test backlog' },
        resolveUploader: async (userId) =>
          userId === hr.userId
            ? {
                userId,
                username: hr.username,
                fullName: 'HR',
                role: 'HR',
                mustChangePassword: false,
              }
            : null,
      },
    )

    expect(outcomes[0]?.usedFallback).toBe(false)
    expect(outcomes[0]?.result?.status).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)

    // Out of the backlog, a second decision on the row, in HR's name.
    const after = await settled(agent, letter.documentId)
    expect(after.signatureStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
    expect(after.stampDecision?.mode).toBe('Report')
    const decisions = await request.query<{ N: number; DecidedBy: number }>(
      `SELECT COUNT(*) AS N, MAX(DecidedBy) AS DecidedBy FROM dbo.StampDecisions WHERE DocumentId = ${letter.documentId}`,
    )
    expect(decisions.recordset[0]?.N).toBe(2)
    expect(decisions.recordset[0]?.DecidedBy).toBe(hr.userId)
    expect(
      (await employeeDocumentRepository.listSignatureBacklog(100)).map((r) => r.documentId),
    ).not.toContain(letter.documentId)
  })
})
