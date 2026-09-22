import { existsSync } from 'node:fs'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SIGNATURE_STATUS,
  SIGNER_ROLES,
  addDays,
  todayDateOnly,
  type EmployeeDocument,
} from '@asps-dms/shared'
import { env } from '../../src/config/env.js'
import { createRequest } from '../../src/database/pool.js'
import * as documentTypePlacementRepository from '../../src/repositories/documentTypePlacement.repository.js'
import * as documentTypeRepository from '../../src/repositories/documentType.repository.js'
import * as employeeDocumentRepository from '../../src/repositories/employeeDocument.repository.js'
import * as signaturePlacementRepository from '../../src/repositories/signaturePlacement.repository.js'
import { run } from '../../src/services/autoStampRun.service.js'
import { readStoredFile, resolveWithinRoot } from '../../src/services/storage.service.js'
import { apply, plan } from '../../src/services/unstamp.service.js'
import { app, closeDatabase, createUser, ensureSchema, resetData, signIn } from './helpers.js'

/**
 * Taking the application's stamp off a real document.
 *
 * A document is stamped on upload the real way, then unstamped through the
 * command's own service. What only the database and the disk can prove: the
 * processed file is gone from both, the placement rows are gone, the status
 * is Skipped, the original is what is served, the audit entry carries the
 * reason - and nothing that looks for documents to stamp finds it again.
 */

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

const context = { ipAddress: null, userAgent: 'unstamp test' }

let codeSeq = 0

describe('unstamp, end to end', () => {
  const originalMode = env.AUTO_STAMP
  let admin: Awaited<ReturnType<typeof createUser>>
  let hr: Awaited<ReturnType<typeof createUser>>
  let agent: Awaited<ReturnType<typeof signIn>>

  beforeAll(async () => {
    await ensureSchema()
    await resetData()
    ;(env as { AUTO_STAMP: string }).AUTO_STAMP = 'stamp'

    admin = await createUser('admin.unstamp', 'ADMIN')
    hr = await createUser('hr.unstamp', 'HR')
    agent = await signIn(app(), hr)

    const types = await documentTypeRepository.listActive()
    const letterTypeId =
      types.find((t) => t.documentCode === 'APPOINTMENT_LETTER')?.documentTypeId ?? 0
    await documentTypePlacementRepository.replaceForVariant(
      letterTypeId,
      A4,
      [
        { ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, x: 0.1, y: 0.85 },
        { ...BOX, signerRole: SIGNER_ROLES.AUTHORISER, x: 0.6, y: 0.85 },
      ],
      null,
      admin.userId,
    )

    const mine = await agent
      .post('/api/me/signature')
      .field('capture', 'Uploaded')
      .attach('file', signaturePng(), { filename: 'mine.png', contentType: 'image/png' })
    expect(mine.status).toBe(200)
  })

  afterAll(async () => {
    ;(env as { AUTO_STAMP: string }).AUTO_STAMP = originalMode
    await closeDatabase()
  })

  /** An appointment letter stamped on upload, the real way. */
  async function stampedLetter(): Promise<{ document: EmployeeDocument; employeeId: number }> {
    const created = await agent.post('/api/employees').send({
      employeeCode: `US${++codeSeq}`,
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
    return { document, employeeId: employee.employeeId as number }
  }

  it('takes the stamp off: rows, file and status, with the reason on the trail, and nothing finds it again', async () => {
    const { document, employeeId } = await stampedLetter()
    const before = await employeeDocumentRepository.findStoredFile(document.documentId)
    const processedPath = before?.processedFilePath
    expect(processedPath).toBeTruthy()
    expect(existsSync(resolveWithinRoot(processedPath as string))).toBe(true)
    // What is served now is the signed copy; the original is on disk beside it.
    const servedBefore = (await agent.get(`/api/documents/${document.documentId}/download`)).body
    const originalBytes = await readStoredFile(before?.originalFilePath as string)
    expect(Buffer.compare(servedBefore, originalBytes)).not.toBe(0)

    const planned = await plan([document.documentId])
    expect(planned.toRemove).toHaveLength(1)
    expect(planned.lines[0]?.placements.map((p) => p.method)).toEqual(['Automatic', 'Automatic'])

    const result = await apply(planned, {
      reason: 'signed by MMC before upload',
      actor: { ...admin, fullName: 'Admin', role: 'ADMIN', mustChangePassword: false },
      context,
    })
    expect(result.failed).toEqual([])
    expect(result.done).toEqual([
      { documentId: document.documentId, placementsRemoved: 2, processedFileRemoved: true },
    ])

    // The rows are gone, the file is gone from the row and from the disk.
    expect(await signaturePlacementRepository.listForDocument(document.documentId)).toEqual([])
    const after = await employeeDocumentRepository.findStoredFile(document.documentId)
    expect(after?.processedFilePath).toBeNull()
    expect(after?.originalFilePath).toBe(before?.originalFilePath)
    expect(existsSync(resolveWithinRoot(processedPath as string))).toBe(false)

    // Skipped, and the original is what is served now.
    const shown = (await agent.get(`/api/documents/${document.documentId}`)).body
      .document as EmployeeDocument
    expect(shown.signatureStatus).toBe(SIGNATURE_STATUS.SKIPPED)
    expect(shown.hasProcessedFile).toBe(false)
    const served = await agent.get(`/api/documents/${document.documentId}/download`)
    expect(served.status).toBe(200)
    expect(Buffer.compare(served.body, originalBytes)).toBe(0)

    // The audit trail says who, why, and what went.
    const request = await createRequest()
    const trail = await request.query<{ Metadata: string; UserId: number }>(
      `SELECT Metadata, UserId FROM dbo.AuditLogs
       WHERE Action = 'SIGNATURE_REMOVED' AND EntityId = '${document.documentId}'`,
    )
    expect(trail.recordset).toHaveLength(1)
    expect(trail.recordset[0]?.UserId).toBe(admin.userId)
    expect(JSON.parse(trail.recordset[0]?.Metadata ?? '{}')).toMatchObject({
      source: 'unstamp command',
      reason: 'signed by MMC before upload',
      previousStatus: 'Added',
      newStatus: 'Skipped',
      placementsRemoved: 2,
      processedFileRemoved: true,
    })

    // Nothing that looks for documents to stamp sees it: not the upload
    // runner, not the watcher's list, not the backlog.
    const rerun = await run(
      document.documentId,
      { ...hr, fullName: 'HR', role: 'HR', mustChangePassword: false },
      context,
    )
    expect(rerun).toBeNull()
    const awaiting = await employeeDocumentRepository.listAwaitingSignature(employeeId)
    expect(awaiting.map((row) => row.documentId)).not.toContain(document.documentId)
    const backlog = await employeeDocumentRepository.listSignatureBacklog(500)
    expect(backlog.map((row) => row.documentId)).not.toContain(document.documentId)
    expect(await signaturePlacementRepository.listForDocument(document.documentId)).toEqual([])
  })

  it('refuses a document a person placed on, and leaves it exactly as it was', async () => {
    const { document } = await stampedLetter()
    // HR adjusted one of the boxes by hand: that document is theirs, not the command's.
    await signaturePlacementRepository.replaceForDocument(
      document.documentId,
      document.employeeId,
      [
        {
          pageNumber: 1,
          x: 0.1,
          y: 0.85,
          width: 0.28,
          height: 0.09,
          pageRotation: 0,
          method: 'Automatic',
          detectionMethod: 'Template',
          confidence: null,
          signerRole: SIGNER_ROLES.EMPLOYEE,
          signerUserId: null,
        },
        {
          pageNumber: 1,
          x: 0.6,
          y: 0.85,
          width: 0.28,
          height: 0.09,
          pageRotation: 0,
          method: 'Adjusted',
          detectionMethod: 'Manual',
          confidence: null,
          signerRole: SIGNER_ROLES.AUTHORISER,
          signerUserId: hr.userId,
        },
      ],
      hr.userId,
    )
    const before = await employeeDocumentRepository.findStoredFile(document.documentId)

    const planned = await plan([document.documentId, 999_999])
    expect(planned.toRemove).toEqual([])
    expect(planned.refused.map((line) => line.verdict)).toEqual([
      { action: 'refuse', reason: 'placed by a person (Adjusted) - not the application' },
      { action: 'refuse', reason: 'no such document' },
    ])

    const result = await apply(planned, {
      reason: 'x',
      actor: { ...admin, fullName: 'Admin', role: 'ADMIN', mustChangePassword: false },
      context,
    })
    expect(result.done).toEqual([])

    const after = await employeeDocumentRepository.findStoredFile(document.documentId)
    expect(after?.processedFilePath).toBe(before?.processedFilePath)
    expect(existsSync(resolveWithinRoot(before?.processedFilePath as string))).toBe(true)
    expect(await signaturePlacementRepository.listForDocument(document.documentId)).toHaveLength(2)
    const shown = (await agent.get(`/api/documents/${document.documentId}`)).body
      .document as EmployeeDocument
    expect(shown.signatureStatus).toBe(SIGNATURE_STATUS.ADDED)
  })
})
