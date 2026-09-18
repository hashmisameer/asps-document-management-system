import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, todayDateOnly } from '@asps-dms/shared'
import { app, closeDatabase, createUser, ensureSchema, resetData, signIn } from './helpers.js'
import * as reminderRepository from '../../src/repositories/reminder.repository.js'
import { buildDigest } from '../../src/services/reminderDigest.service.js'
import { readXlsx } from '../../src/utils/xlsx.js'

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

let codeSeq = 0

// Three days ago, not a fixed date: HR may only add somebody who joined
// within the last week, and a date written here would fall out of that week.
const JOINED = addDays(todayDateOnly(), -3)

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
      .send({ employeeCode: `E${++codeSeq}`, employeeName: 'Ravi Kumar', joiningDate: JOINED })
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
      .send({ employeeCode: `E${++codeSeq}`, employeeName: 'Departed Person', joiningDate: JOINED })
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

  it('builds a digest with the overdue documents in the sheet, not the body', async () => {
    await resetData()
    const express = app()
    const agent = await signIn(express, await createUser('hr.digest', 'HR'))

    const created = await agent
      .post('/api/employees')
      .send({ employeeCode: `E${++codeSeq}`, employeeName: 'Ravi Kumar', joiningDate: JOINED })
    const employee = created.body.employee

    // Judged a month from now: the week-and-fortnight documents are late by
    // then, the six-month confirmation letter is not.
    const rows = await reminderRepository.findPendingDocuments()
    const digest = buildDigest(rows, { today: addDays(todayDateOnly(), 30) })

    expect(digest).not.toBeNull()
    expect(digest?.subject).toMatch(/^ASPS-DMS: 1 employee with \d+ overdue documents$/)

    const sheet = readXlsx(Buffer.from(digest?.attachment.bytes ?? new Uint8Array()))
    expect(sheet[0]).toEqual([
      'employee_id',
      'employee_name',
      'documents_pending',
      'overdue_dates',
      'days of overdue',
    ])
    const documents = sheet.slice(1).map((cells) => cells[2])
    expect(documents).toContain('Aadhaar Card')
    expect(documents).not.toContain('Confirmation Letter')
    for (const cells of sheet.slice(1)) {
      expect(cells[0]).toBe(employee.employeeCode)
      expect(cells[1]).toBe('Ravi Kumar')
      expect(cells[3]).toMatch(/^\d{2}\/\d{2}\/\d{4}$/)
      expect(Number(cells[4])).toBeGreaterThan(0)
    }

    // The list has moved out of the body.
    expect(digest?.text).not.toContain('Ravi Kumar')
    expect(digest?.text).toContain(digest?.attachment.fileName ?? '')
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
