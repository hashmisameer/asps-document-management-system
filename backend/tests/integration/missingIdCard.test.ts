import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, todayDateOnly } from '@asps-dms/shared'
import { createRequest } from '../../src/database/pool.js'
import { app, closeDatabase, createUser, ensureSchema, resetData, signIn } from './helpers.js'

/**
 * 'Missing an ID card', against the real tables: the dashboard tile and the
 * employee list it opens must count the same people.
 *
 * They did not. The tile left out a card set aside for one employee and the
 * list did not, so on the server the tile said 1 and the list said 202 - the
 * 201 being contract staff whose PAN is not required of them, who have none.
 * A set-aside card is not missing; an expected one with no file is.
 */

async function cardPdf(title: string): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595, 842])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText(title, { x: 50, y: 780, size: 14, font })
  return Buffer.from(await pdf.save())
}

// Three days ago: HR may only add somebody who joined within the last week.
const JOINED = addDays(todayDateOnly(), -3)

describe('missing an ID card', () => {
  let agent: Awaited<ReturnType<typeof signIn>>
  let adminId = 0

  beforeAll(async () => {
    await ensureSchema()
    await resetData()
    const admin = await createUser('admin.idcard', 'ADMIN')
    adminId = admin.userId
    agent = await signIn(app(), admin)
  })

  afterAll(async () => {
    await closeDatabase()
  })

  async function employee(code: string): Promise<{ employeeId: number; card: (c: string) => number }> {
    const created = await agent
      .post('/api/employees')
      .send({ employeeCode: code, employeeName: 'Ravi Kumar', joiningDate: JOINED })
    expect(created.status).toBe(201)
    const employeeId = created.body.employee.employeeId as number
    const checklist = await agent.get(`/api/employees/${employeeId}/documents`)
    const documents = checklist.body.documents as { documentId: number; documentCode: string }[]
    const card = (documentCode: string) =>
      documents.find((d) => d.documentCode === documentCode)?.documentId as number
    return { employeeId, card }
  }

  /** A card accepted on trust, so the identity check does not read - or refuse - it. */
  async function receive(documentId: number): Promise<void> {
    const uploaded = await agent
      .post(`/api/documents/${documentId}/file`)
      .field('identityOverrideReason', 'Checked against the original by HR')
      .attach('file', await cardPdf('IDENTITY CARD'), {
        filename: 'card.pdf',
        contentType: 'application/pdf',
      })
    expect(uploaded.status).toBe(200)
  }

  it('lists an expected card that is missing, never a set-aside one, and agrees with the tile', async () => {
    // Contract staff: Aadhaar in, PAN set aside - nothing is missing.
    const contract = await employee('IDC0001')
    await receive(contract.card('AADHAAR_CARD'))
    // Set aside in the table rather than through PATCH /not-required. In this
    // suite that endpoint answers 409 on a write that succeeded: the pooled
    // connection carries SET NOCOUNT ON from the migrations ensureSchema runs,
    // so rowsAffected comes back empty (see scripts/nocountCheck.ts). That is
    // its own fault; what is tested here is the query, not that endpoint.
    await (await createRequest())
      .input('documentId', contract.card('PAN_CARD'))
      .input('by', adminId)
      .query(`UPDATE dbo.EmployeeDocuments
              SET NotRequiredAt = SYSUTCDATETIME(), NotRequiredBy = @by
              WHERE DocumentId = @documentId`)

    // PAN in, Aadhaar never arrived - missing an ID card.
    const missing = await employee('IDC0002')
    await receive(missing.card('PAN_CARD'))

    // Both in.
    const complete = await employee('IDC0003')
    await receive(complete.card('AADHAAR_CARD'))
    await receive(complete.card('PAN_CARD'))

    const list = await agent.get('/api/employees?missingIdCard=true&status=active')
    expect(list.status).toBe(200)
    const ids = (list.body.items as { employeeId: number }[]).map((e) => e.employeeId)
    expect(ids).toContain(missing.employeeId)
    expect(ids).not.toContain(contract.employeeId)
    expect(ids).not.toContain(complete.employeeId)

    // The tile counts exactly the people the list it opens shows.
    const summary = await agent.get('/api/dashboard/summary')
    expect(summary.status).toBe(200)
    expect(summary.body.summary.employeesMissingMandatory).toBe(ids.length)
    expect(ids).toEqual([missing.employeeId])
  })
})
