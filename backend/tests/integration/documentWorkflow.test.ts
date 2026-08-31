import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DOCUMENT_STATUS } from '@asps-dms/shared'
import { app, closeDatabase, createUser, ensureSchema, resetData, signIn } from './helpers.js'

/**
 * An employee, their checklist, and a document going onto it.
 *
 * The whole path, over HTTP, against a real SQL Server: the paginated query,
 * the checklist materialised by a trigger of application code rather than a
 * mock, the identity check reading an actual PDF, and the deadline derived from
 * a real DATE column. None of that is exercised by the unit tests, which mock
 * the repository layer precisely so they can be fast.
 */

/** A PDF with a real text layer, so the identity check has something to read. */
async function documentFor(
  fields: { name: string; code: string; joining: string },
): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595, 842])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText('ASPS INTERNATIONAL - APPOINTMENT LETTER', { x: 50, y: 780, size: 14, font })
  page.drawText(`Name: ${fields.name}`, { x: 50, y: 740, size: 12, font })
  page.drawText(`Employee Code: ${fields.code}`, { x: 50, y: 720, size: 12, font })
  page.drawText(`Date of Joining: ${fields.joining}`, { x: 50, y: 700, size: 12, font })
  return Buffer.from(await pdf.save())
}

let codeSeq = 0

describe('employee documents, end to end', () => {
  beforeAll(async () => {
    await ensureSchema()
    await resetData()
  })

  afterAll(async () => {
    await closeDatabase()
  })

  it('materialises a full checklist when an employee is created', async () => {
    const express = app()
    const agent = await signIn(express, await createUser('hr.checklist', 'HR'))

    const created = await agent
      .post('/api/employees')
      .send({ employeeCode: `E${++codeSeq}`, employeeName: 'Ravi Kumar', joiningDate: '2026-04-01', department: 'Accounts' })

    expect(created.status).toBe(201)
    // The code is the one that was sent. HR types the company's own number,
    // because the identity check compares it with what is printed on the
    // document - a generated EMP003 would never match a real service card.
    expect(created.body.employee.employeeCode).toBe(`E${codeSeq}`)

    const checklist = await agent.get(`/api/employees/${created.body.employee.employeeId}/documents`)
    expect(checklist.status).toBe(200)
    expect(checklist.body.documents.length).toBeGreaterThan(0)

    // The rule confirmed on 2026-08-31: only the two identity cards are
    // mandatory. Asserted against the seeded types, so a seed that drifted
    // would fail here rather than in front of HR.
    const mandatory = checklist.body.documents
      .filter((d: { isMandatory: boolean }) => d.isMandatory)
      .map((d: { documentName: string }) => d.documentName)
      .sort()
    expect(mandatory).toEqual(['Aadhaar Card', 'PAN Card'])

    // Optional does not mean undated: every row still carries a deadline.
    const dated = checklist.body.documents.filter((d: { dueDate: string | null }) => d.dueDate)
    expect(dated).toHaveLength(checklist.body.documents.length)
  })

  it('accepts a document that confirms the employee, and refuses one that does not', async () => {
    await resetData()
    const express = app()
    const agent = await signIn(express, await createUser('hr.upload', 'HR'))

    const created = await agent
      .post('/api/employees')
      .send({ employeeCode: `E${++codeSeq}`, employeeName: 'Ravi Kumar', joiningDate: '2026-04-01' })
    const employee = created.body.employee

    const checklist = await agent.get(`/api/employees/${employee.employeeId}/documents`)
    const target = checklist.body.documents.find(
      (d: { documentName: string }) => d.documentName === 'Appointment Letter',
    )

    // The right document: name, code and joining date all present.
    const good = await documentFor({
      name: employee.employeeName,
      code: employee.employeeCode,
      joining: '01/04/2026',
    })
    const accepted = await agent
      .post(`/api/documents/${target.documentId}/file`)
      .attach('file', good, { filename: 'appointment.pdf', contentType: 'application/pdf' })

    expect(accepted.status).toBe(200)
    expect(accepted.body.document.identityCheck.status).toBe('Passed')
    expect(accepted.body.document.status).toBe(DOCUMENT_STATUS.UPLOADED)

    // Somebody else's document, filed against this employee. The mistake the
    // whole check exists to catch.
    const wrong = await documentFor({
      name: 'Anita Desai',
      code: 'EMP999',
      joining: '01/01/2020',
    })
    const other = checklist.body.documents.find(
      (d: { documentName: string }) => d.documentName === 'Bio Data Form',
    )
    const refused = await agent
      .post(`/api/documents/${other.documentId}/file`)
      .attach('file', wrong, { filename: 'wrong.pdf', contentType: 'application/pdf' })

    expect(refused.status).toBe(422)
    expect(refused.body.error.code).toBe('IDENTITY_CHECK_FAILED')

    // And nothing was stored: a refused document must not be on the record.
    const after = await agent.get(`/api/documents/${other.documentId}`)
    expect(after.body.document.originalFileName).toBeNull()
  })

  it('accepts a refused document when a reason is given, and records who gave it', async () => {
    await resetData()
    const express = app()
    const user = await createUser('hr.override', 'HR')
    const agent = await signIn(express, user)

    const created = await agent
      .post('/api/employees')
      .send({ employeeCode: `E${++codeSeq}`, employeeName: 'Ravi Kumar', joiningDate: '2026-04-01' })
    const checklist = await agent.get(
      `/api/employees/${created.body.employee.employeeId}/documents`,
    )
    const target = checklist.body.documents.find(
      (d: { documentName: string }) => d.documentName === 'Appointment Letter',
    )

    const wrong = await documentFor({ name: 'Someone Else', code: 'EMP999', joining: '01/01/2020' })

    const overridden = await agent
      .post(`/api/documents/${target.documentId}/file`)
      .field('identityOverrideReason', 'The scan is too faint for the code to be read')
      .attach('file', wrong, { filename: 'faint.pdf', contentType: 'application/pdf' })

    expect(overridden.status).toBe(200)
    expect(overridden.body.document.identityCheck.status).toBe('Overridden')
    // Stored on the document, not only in the audit trail: it has to be visible
    // months later without knowing to go looking for it.
    expect(overridden.body.document.identityCheck.overrideReason).toContain('too faint')
    expect(overridden.body.document.identityCheck.overriddenByName).toContain('hr.override')
  })

  it('stops a Viewer uploading, and lets them read', async () => {
    await resetData()
    const express = app()
    const hr = await signIn(express, await createUser('hr.reader', 'HR'))
    const created = await hr
      .post('/api/employees')
      .send({ employeeCode: `E${++codeSeq}`, employeeName: 'Ravi Kumar', joiningDate: '2026-04-01' })

    const viewer = await signIn(express, await createUser('viewer.reader', 'VIEWER'))

    expect((await viewer.get('/api/employees')).status).toBe(200)
    expect(
      (
        await viewer
          .post('/api/employees')
          .send({ employeeCode: `E${++codeSeq}`, employeeName: 'Nope', joiningDate: '2026-04-01' })
      ).status,
    ).toBe(403)

    const checklist = await viewer.get(
      `/api/employees/${created.body.employee.employeeId}/documents`,
    )
    expect(checklist.status).toBe(200)
  })
})
