import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { app, closeDatabase, createUser, ensureSchema, resetData, signIn } from './helpers.js'
import * as reminderRepository from '../../src/repositories/reminder.repository.js'
import { buildDigest } from '../../src/services/reminderDigest.service.js'

/**
 * The reminder digest, built from what is actually in the database.
 *
 * The unit tests pin the wording and the grouping against plain rows. What can
 * only be checked here is the query underneath them: that "pending" really does
 * mean a document with no file, that a document stops being chased the moment
 * one arrives, and that an archived employee drops out.
 */

async function pdfFor(name: string, code: string): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595, 842])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText('ASPS INTERNATIONAL - APPOINTMENT LETTER', { x: 50, y: 780, size: 14, font })
  page.drawText(`Name: ${name}`, { x: 50, y: 740, size: 12, font })
  page.drawText(`Employee Code: ${code}`, { x: 50, y: 720, size: 12, font })
  page.drawText('Date of Joining: 01/04/2026', { x: 50, y: 700, size: 12, font })
  return Buffer.from(await pdf.save())
}

describe('the pending-documents reminder', () => {
  beforeAll(async () => {
    await ensureSchema()
    await resetData()
  })

  afterAll(async () => {
    await closeDatabase()
  })

  it('stops naming a document once its file is uploaded', async () => {
    // The behaviour that was asked for: the reminder keeps coming until the
    // document is uploaded, and not one run longer.
    const express = app()
    const agent = await signIn(express, await createUser('hr.reminder', 'HR'))

    const created = await agent
      .post('/api/employees')
      .send({ employeeName: 'Ravi Kumar', joiningDate: '2026-04-01' })
    const employee = created.body.employee

    const before = await reminderRepository.findPendingDocuments()
    const beforeNames = before
      .filter((row) => row.employeeId === employee.employeeId)
      .map((row) => row.documentName)
    expect(beforeNames).toContain('Appointment Letter')

    const checklist = await agent.get(`/api/employees/${employee.employeeId}/documents`)
    const target = checklist.body.documents.find(
      (d: { documentName: string }) => d.documentName === 'Appointment Letter',
    )
    const upload = await agent
      .post(`/api/documents/${target.documentId}/file`)
      .attach('file', await pdfFor(employee.employeeName, employee.employeeCode), {
        filename: 'appointment.pdf',
        contentType: 'application/pdf',
      })
    expect(upload.status).toBe(200)

    const after = await reminderRepository.findPendingDocuments()
    const afterNames = after
      .filter((row) => row.employeeId === employee.employeeId)
      .map((row) => row.documentName)

    expect(afterNames).not.toContain('Appointment Letter')
    // The others are untouched: uploading one document does not silence the rest.
    expect(afterNames.length).toBe(beforeNames.length - 1)
  })

  it('leaves out an archived employee', async () => {
    await resetData()
    const express = app()
    const agent = await signIn(express, await createUser('hr.archive', 'HR'))

    const created = await agent
      .post('/api/employees')
      .send({ employeeName: 'Departed Person', joiningDate: '2026-04-01' })
    const employeeId = created.body.employee.employeeId

    expect(
      (await reminderRepository.findPendingDocuments()).some((r) => r.employeeId === employeeId),
    ).toBe(true)

    const archived = await agent.post(`/api/employees/${employeeId}/archive`)
    expect(archived.status).toBe(200)

    // Nobody chases paperwork for someone who has left.
    expect(
      (await reminderRepository.findPendingDocuments()).some((r) => r.employeeId === employeeId),
    ).toBe(false)
  })

  it('builds a digest naming the employee and their documents', async () => {
    await resetData()
    const express = app()
    const agent = await signIn(express, await createUser('hr.digest', 'HR'))

    const created = await agent
      .post('/api/employees')
      .send({ employeeName: 'Ravi Kumar', joiningDate: '2026-04-01' })
    const employee = created.body.employee

    const rows = await reminderRepository.findPendingDocuments()
    const digest = buildDigest(rows, { today: '2026-09-30' })

    expect(digest).not.toBeNull()
    expect(digest?.text).toContain(employee.employeeCode)
    expect(digest?.text).toContain('Ravi Kumar')
    expect(digest?.text).toContain('Aadhaar Card')
    expect(digest?.subject).toContain('pending documents')
  })

  it('sends nothing when every employee is up to date', async () => {
    await resetData()
    // No employees at all: nothing outstanding, so no email. A daily message
    // saying all is well is one people learn to delete unread.
    const rows = await reminderRepository.findPendingDocuments()
    expect(buildDigest(rows, { today: '2026-09-30' })).toBeNull()
  })

  it('refuses to send for a Viewer, and previews for HR', async () => {
    await resetData()
    const express = app()

    const viewer = await signIn(express, await createUser('viewer.reminder', 'VIEWER'))
    expect((await viewer.post('/api/reminders/send?dryRun=true')).status).toBe(403)

    const hr = await signIn(express, await createUser('hr.sender', 'HR'))
    const preview = await hr.post('/api/reminders/send?dryRun=true')
    expect(preview.status).toBe(200)
    expect(preview.body.reminder.dryRun).toBe(true)
    expect(preview.body.reminder.sent).toBe(false)
  })
})
