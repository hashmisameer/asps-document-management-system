import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
import { createRequest } from '../../src/database/pool.js'
import * as documentTypePlacementRepository from '../../src/repositories/documentTypePlacement.repository.js'
import * as documentTypeRepository from '../../src/repositories/documentType.repository.js'
import * as employeeRepository from '../../src/repositories/employee.repository.js'
import * as userRepository from '../../src/repositories/user.repository.js'
import { attachMissing } from '../../src/services/mmcImages.service.js'
import { run as runStampDecision } from '../../src/services/autoStampRun.service.js'
import {
  createMmcWatcher,
  realDeps,
  type MmcJobOutcome,
} from '../../src/services/mmcWatch.service.js'
import { app, closeDatabase, createUser, ensureSchema, resetData, signIn } from './helpers.js'

/**
 * The MMC pickup, end to end: real folders on disk, a real JPEG dropped in,
 * the real watcher, the real database.
 *
 * The case that kept biting: the employee exists, their appointment letter
 * is uploaded and left alone for 'the employee has no signature on file',
 * and then MMC writes the signature. Nothing looked again. Now something does.
 */

const JOINED = addDays(todayDateOnly(), -3)
const JOINED_ON_PAPER = JOINED.split('-').reverse().join('/')

/** A signature the way MMC writes one: ink on white, as a JPEG. */
function mmcSignatureJpeg(): Buffer {
  const canvas = createCanvas(400, 160)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 400, 160)
  ctx.strokeStyle = '#1a1a6e'
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.moveTo(30, 110)
  ctx.bezierCurveTo(120, 20, 200, 150, 370, 60)
  ctx.stroke()
  return canvas.toBuffer('image/jpeg')
}

/** A photograph the way MMC writes one. */
function mmcPhotoJpeg(): Buffer {
  const canvas = createCanvas(300, 400)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#c8b8a0'
  ctx.fillRect(0, 0, 300, 400)
  ctx.fillStyle = '#5a3d2b'
  ctx.beginPath()
  ctx.arc(150, 160, 70, 0, Math.PI * 2)
  ctx.fill()
  return canvas.toBuffer('image/jpeg')
}

async function letterFor(name: string, code: string): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595.28, 841.89])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText('ASPS INTERNATIONAL - APPOINTMENT LETTER', { x: 50, y: 780, size: 14, font })
  page.drawText(`Name: ${name}`, { x: 50, y: 740, size: 12, font })
  page.drawText(`Employee Code: ${code}`, { x: 50, y: 720, size: 12, font })
  page.drawText(`Date of Joining: ${JOINED_ON_PAPER}`, { x: 50, y: 700, size: 12, font })
  return Buffer.from(await pdf.save())
}

async function settledDocument(
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

/**
 * Waits for the watcher's FINAL word on a file. A file written while the
 * watcher listens fires its event before the bytes have landed, so the first
 * look rightly says 'still being written' and a retry follows; that is the
 * behaviour, not the answer.
 */
async function outcomeWhere(
  outcomes: MmcJobOutcome[],
  predicate: (o: MmcJobOutcome) => boolean,
  timeoutMs = 30_000,
): Promise<MmcJobOutcome> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const found = outcomes.find((o) => predicate(o) && o.result !== 'notSettled')
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`no outcome matched; saw ${JSON.stringify(outcomes.map((o) => o.result))}`)
}

describe('the MMC pickup, end to end', () => {
  let root = ''
  let dirs = { photo: '', signature: '' }
  let letterTypeId = 0

  beforeAll(async () => {
    await ensureSchema()
    await resetData()
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'asps-mmc-'))
    dirs = { photo: path.join(root, 'Image'), signature: path.join(root, 'Signature') }
    await fs.mkdir(dirs.photo)
    await fs.mkdir(dirs.signature)

    const admin = await createUser('admin.mmc', 'ADMIN')
    const types = await documentTypeRepository.listActive()
    letterTypeId = types.find((t) => t.documentCode === 'APPOINTMENT_LETTER')?.documentTypeId ?? 0
    await documentTypePlacementRepository.replaceForVariant(
      letterTypeId,
      { pageCount: 1, widthPt: 595, heightPt: 842 },
      [
        {
          signerRole: SIGNER_ROLES.EMPLOYEE,
          pageNumber: 1,
          x: 0.1,
          y: 0.85,
          width: 0.28,
          height: 0.09,
          pageRotation: 0,
          pageWidthPt: 595.28,
          pageHeightPt: 841.89,
        },
      ],
      null,
      admin.userId,
    )
  })

  afterAll(async () => {
    await closeDatabase()
    await fs.rm(root, { recursive: true, force: true })
  })

  /** The real collaborators, pointed at the temp folders, with a fast sweep clock off. */
  function deps(outcomes: MmcJobOutcome[]) {
    const real = realDeps()
    return {
      ...real,
      dirs,
      attachMissing,
      runStampDecision,
      findCandidateByCode: employeeRepository.findMmcCandidateByCode,
      listCandidatesMissingImages: employeeRepository.listMmcCandidatesMissingImages,
      findEmployee: employeeRepository.findById,
      resolveUser: async (userId: number) => {
        const user = await userRepository.findById(userId)
        return user && user.isActive ? userRepository.toAuthUser(user) : null
      },
      actor: async () => {
        const admin = await userRepository.findByUsername('admin.mmc')
        if (!admin) throw new Error('no admin')
        return userRepository.toAuthUser(admin)
      },
      sweepMinutes: 0,
      onOutcome: (o: MmcJobOutcome) => outcomes.push(o),
    }
  }

  it('takes in a signature that MMC writes later, and decides the waiting document again', async () => {
    const hr = await createUser('hr.mmc', 'HR')
    const agent = await signIn(app(), hr)
    const code = '00006100'

    // The employee, with no signature anywhere yet; their letter uploaded and
    // left alone for want of one.
    const created = await agent
      .post('/api/employees')
      .send({ employeeCode: code, employeeName: 'Ravi Kumar', joiningDate: JOINED })
    expect(created.status).toBe(201)
    const employeeId = created.body.employee.employeeId as number
    const checklist = await agent.get(`/api/employees/${employeeId}/documents`)
    const letter = checklist.body.documents.find(
      (d: { documentCode: string }) => d.documentCode === 'APPOINTMENT_LETTER',
    )
    const upload = await agent
      .post(`/api/documents/${letter.documentId}/file`)
      .attach('file', await letterFor('Ravi Kumar', code), {
        filename: 'letter.pdf',
        contentType: 'application/pdf',
      })
    expect(upload.status).toBe(200)
    const before = await settledDocument(agent, letter.documentId)
    expect(before.signatureStatus).toBe(SIGNATURE_STATUS.REVIEW_REQUIRED)
    expect(before.stampDecision?.outcome).toBe(STAMP_OUTCOMES.NOTHING)
    expect(before.stampDecision?.summary).toContain('the employee has no signature on file')

    // The watcher is listening. Now MMC writes the signature.
    const outcomes: MmcJobOutcome[] = []
    const watcher = createMmcWatcher(deps(outcomes))
    await new Promise((resolve) => setTimeout(resolve, 300))
    await fs.writeFile(path.join(dirs.signature, `${code}.jpg`), mmcSignatureJpeg())

    const outcome = await outcomeWhere(outcomes, (o) => o.job.employeeCode === code)
    watcher.stop()

    expect(outcome.result).toBe('attached')
    expect(outcome.job.kind).toBe('signature')
    expect(outcome.decided).toBeGreaterThanOrEqual(1)

    // The record has the signature, and the letter was decided about again -
    // this time with a signature to stamp (report mode: recorded, not painted).
    const signature = await agent.get(`/api/employees/${employeeId}/signature`)
    expect(signature.body.signature.hasSignature).toBe(true)

    const after = await settledDocument(agent, letter.documentId)
    expect(after.stampDecision?.outcome).toBe(STAMP_OUTCOMES.STAMPED)
    expect(after.stampDecision?.summary).toBe('Stamped: employee signature.')
    const request = await createRequest()
    const decisions = await request.query<{ N: number }>(
      `SELECT COUNT(*) AS N FROM dbo.StampDecisions WHERE DocumentId = ${letter.documentId}`,
    )
    expect(decisions.recordset[0]?.N).toBe(2)
  })

  it('takes in a photograph the same way, and the sweep finds one the watcher never heard', async () => {
    const hr = await createUser('hr.mmc2', 'HR')
    const agent = await signIn(app(), hr)
    const code = '00006101'

    const created = await agent
      .post('/api/employees')
      .send({ employeeCode: code, employeeName: 'Anita Desai', joiningDate: JOINED })
    expect(created.status).toBe(201)
    const employeeId = created.body.employee.employeeId as number

    // Written BEFORE the watcher starts: no event will ever fire for it.
    await fs.writeFile(path.join(dirs.photo, `${code}.jpg`), mmcPhotoJpeg())

    const outcomes: MmcJobOutcome[] = []
    const watcher = createMmcWatcher(deps(outcomes))
    const queued = await watcher.sweep('startup')
    expect(queued).toBeGreaterThanOrEqual(1)

    const outcome = await outcomeWhere(outcomes, (o) => o.job.employeeCode === code)
    watcher.stop()

    expect(outcome.result).toBe('attached')
    expect(outcome.job.kind).toBe('photo')
    expect(outcome.job.via).toBe('startup')

    const photo = await agent.get(`/api/employees/${employeeId}/photo/image`)
    expect(photo.status).toBe(200)
  })

  it('leaves alone a file for an employee who already has the image', async () => {
    const code = '00006100' // has a signature since the first test
    const outcomes: MmcJobOutcome[] = []
    const watcher = createMmcWatcher(deps(outcomes))
    await new Promise((resolve) => setTimeout(resolve, 300))

    await fs.writeFile(path.join(dirs.signature, `${code}.jpg`), mmcSignatureJpeg())
    const outcome = await outcomeWhere(outcomes, (o) => o.job.employeeCode === code)
    watcher.stop()

    expect(outcome.result).toBe('alreadyHad')
  })
})
