import { readFile } from 'node:fs/promises'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, todayDateOnly } from '@asps-dms/shared'
import { createRequest } from '../../src/database/pool.js'
import * as dashboardRepository from '../../src/repositories/dashboard.repository.js'
import * as employeeDocumentRepository from '../../src/repositories/employeeDocument.repository.js'
import * as reminderRepository from '../../src/repositories/reminder.repository.js'
import * as reportRepository from '../../src/repositories/report.repository.js'
import { app, closeDatabase, createUser, ensureSchema, resetData, signIn } from './helpers.js'

/**
 * Full and Final Settlement, against the real tables.
 *
 * Every FNF row starts set aside - by the checklist, so with no person's name -
 * and nothing counts it. For the leaver whose FNF arrives, HR marks it
 * required and uploads it; from then on the lists that SHOW documents show it,
 * leaver or not, and the ones that CHASE documents still leave every leaver
 * out. And because the database now lets a set-aside row carry no name, the
 * application must always record the person who sets one aside by hand.
 */

const JOINED = addDays(todayDateOnly(), -3)

async function pdf(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([595, 842]).drawText('FULL AND FINAL SETTLEMENT', { x: 50, y: 780, size: 14, font })
  return Buffer.from(await doc.save())
}

describe('Full and Final Settlement', () => {
  let agent: Awaited<ReturnType<typeof signIn>>
  let adminId = 0
  let fnfTypeId = 0
  let seq = 0

  beforeAll(async () => {
    await ensureSchema()
    await resetData()
    const admin = await createUser('admin.fnf', 'ADMIN')
    adminId = admin.userId
    agent = await signIn(app(), admin)
    const type = await (await createRequest()).query<{ DocumentTypeId: number }>(
      "SELECT DocumentTypeId FROM dbo.DocumentTypes WHERE DocumentCode = 'FNF'",
    )
    fnfTypeId = type.recordset[0]?.DocumentTypeId ?? 0
    expect(fnfTypeId).toBeGreaterThan(0)
  })

  afterAll(async () => {
    await closeDatabase()
  })

  async function employee(): Promise<number> {
    const created = await agent
      .post('/api/employees')
      .send({ employeeCode: `FNF${++seq}`, employeeName: 'Ravi Kumar', joiningDate: JOINED })
    expect(created.status).toBe(201)
    return created.body.employee.employeeId as number
  }

  async function fnfRow(employeeId: number) {
    const result = await (await createRequest())
      .input('employeeId', employeeId)
      .input('typeId', fnfTypeId)
      .query<{
        DocumentId: number
        NotRequiredAt: Date | null
        NotRequiredBy: number | null
        DueDate: Date | null
        Status: string
      }>(`SELECT DocumentId, NotRequiredAt, NotRequiredBy, DueDate, Status
          FROM dbo.EmployeeDocuments
          WHERE EmployeeId = @employeeId AND DocumentTypeId = @typeId AND IsActive = 1`)
    return result.recordset
  }

  /** Makes an employee a leaver: resigned on joining, gone the day after. */
  async function leave(employeeId: number): Promise<void> {
    await (await createRequest())
      .input('employeeId', employeeId)
      .input('resigned', JOINED)
      .input('last', addDays(JOINED, 1))
      .query(`UPDATE dbo.Employees
              SET ResignationDate = @resigned, LastWorkingDate = @last,
                  ExitReason = 'RESIGNED', EmploymentStatus = 'LEFT'
              WHERE EmployeeId = @employeeId`)
  }

  it('puts FNF last on every new checklist, set aside by the checklist: no name, no deadline', async () => {
    const employeeId = await employee()

    const checklist = await agent.get(`/api/employees/${employeeId}/documents`)
    const documents = checklist.body.documents as {
      documentCode: string
      notRequiredAt: string | null
      notRequiredByName: string | null
      dueDate: string | null
      collectedAfterLeaving: boolean
    }[]
    const last = documents.at(-1)
    expect(last?.documentCode).toBe('FNF')
    expect(last?.notRequiredAt).not.toBeNull()
    // Nobody decided: the checklist reads 'mark as required when it arrives'.
    expect(last?.notRequiredByName).toBeNull()
    expect(last?.dueDate).toBeNull()
    expect(last?.collectedAfterLeaving).toBe(true)
    // Only FNF is collected after leaving.
    expect(documents.filter((d) => d.collectedAfterLeaving).map((d) => d.documentCode)).toEqual([
      'FNF',
    ])

    const [row] = await fnfRow(employeeId)
    expect(row?.NotRequiredBy).toBeNull()
  })

  it('counts a set-aside FNF nowhere', async () => {
    const employeeId = await employee()

    const list = await employeeDocumentRepository.listAll({
      page: 1,
      pageSize: 100,
      sortBy: 'dueDate',
      sortDir: 'asc',
      state: 'all',
      employeeId,
    })
    expect(list.rows.map((r) => r.documentName)).not.toContain('FNF')
    const byType = await reportRepository.byDocumentType()
    expect(byType.some((r) => r.documentTypeId === fnfTypeId)).toBe(false)
    const pending = await reminderRepository.findPendingDocuments()
    expect(pending.some((r) => r.documentName === 'FNF')).toBe(false)
  })

  it('shows a leaver\'s FNF once marked required and uploaded - and still never chases it', async () => {
    const employeeId = await employee()
    await leave(employeeId)
    const [row] = await fnfRow(employeeId)
    const documentId = row?.DocumentId as number
    const dashboardBefore = await dashboardRepository.getSummary(7)

    // Marked required by the repository (the PATCH answers 409 in this suite on a
    // write that succeeded - SET NOCOUNT, see missingIdCard.test.ts), then
    // uploaded through the API as HR would.
    await employeeDocumentRepository.setNotRequired(documentId, false, adminId)
    expect((await fnfRow(employeeId))[0]?.NotRequiredAt).toBeNull()
    expect((await fnfRow(employeeId))[0]?.DueDate).toBeNull()
    const uploaded = await agent
      .post(`/api/documents/${documentId}/file`)
      .attach('file', await pdf(), { filename: 'fnf.pdf', contentType: 'application/pdf' })
    expect(uploaded.status).toBe(200)

    // SHOWN: the documents list, the by-document table and the type's own page.
    const list = await employeeDocumentRepository.listAll({
      page: 1,
      pageSize: 100,
      sortBy: 'dueDate',
      sortDir: 'asc',
      state: 'all',
      employeeId,
    })
    expect(list.rows.map((r) => r.documentName)).toEqual(['FNF'])
    const byType = (await reportRepository.byDocumentType()).find(
      (r) => r.documentTypeId === fnfTypeId,
    )
    expect(byType).toMatchObject({ expected: 1, received: 1, outstanding: 0 })
    const page = await reportRepository.employeesForDocumentType({
      documentTypeId: fnfTypeId,
      outstandingOnly: false,
      onlyOverdue: false,
      sortBy: 'employeeName',
      sortDir: 'asc',
      page: 1,
      pageSize: 25,
    })
    // The by-document row and the page it opens agree.
    expect(page.total).toBe(byType?.expected)
    expect(page.rows.map((r) => r.employeeId)).toEqual([employeeId])

    // CHASED: nowhere. The dashboard did not move, the reminder and the
    // outstanding report never name a leaver.
    const dashboardAfter = await dashboardRepository.getSummary(7)
    expect(dashboardAfter.documents).toEqual(dashboardBefore.documents)
    const pending = await reminderRepository.findPendingDocuments()
    expect(pending.some((r) => r.employeeId === employeeId)).toBe(false)
    const outstanding = await reportRepository.outstanding({})
    expect(outstanding.rows.some((r) => r.employeeId === employeeId)).toBe(false)
  })

  it('uploading onto a set-aside row marks it required - no separate click needed', async () => {
    // HR has a leaver's FNF in hand and puts it straight in. The file is
    // evidence it was required after all: the set-aside goes, and the
    // document shows wherever FNF documents are shown.
    const employeeId = await employee()
    await leave(employeeId)
    const [row] = await fnfRow(employeeId)
    expect(row?.NotRequiredAt).not.toBeNull()

    const uploaded = await agent
      .post(`/api/documents/${row?.DocumentId}/file`)
      .attach('file', await pdf(), { filename: 'fnf.pdf', contentType: 'application/pdf' })
    expect(uploaded.status).toBe(200)

    const [after] = await fnfRow(employeeId)
    expect(after).toMatchObject({ NotRequiredAt: null, NotRequiredBy: null })
    const page = await reportRepository.employeesForDocumentType({
      documentTypeId: fnfTypeId,
      outstandingOnly: false,
      onlyOverdue: false,
      sortBy: 'employeeName',
      sortDir: 'asc',
      page: 1,
      pageSize: 25,
    })
    expect(page.rows.map((r) => r.employeeId)).toContain(employeeId)
  })

  it('never shows a leaver\'s other documents', async () => {
    const employeeId = await employee()
    await leave(employeeId)

    const list = await employeeDocumentRepository.listAll({
      page: 1,
      pageSize: 100,
      sortBy: 'dueDate',
      sortDir: 'asc',
      state: 'all',
      employeeId,
    })
    expect(list.rows).toEqual([])
  })

  it('always records the person who sets a document aside by hand', async () => {
    const employeeId = await employee()
    const [row] = await fnfRow(employeeId)
    const documentId = row?.DocumentId as number
    await employeeDocumentRepository.setNotRequired(documentId, false, adminId)

    // Without an actor the write does not happen at all.
    await expect(employeeDocumentRepository.setNotRequired(documentId, true, 0)).rejects.toThrow(
      'needs the person',
    )
    expect((await fnfRow(employeeId))[0]?.NotRequiredAt).toBeNull()

    // With one, the row names them.
    await employeeDocumentRepository.setNotRequired(documentId, true, adminId)
    expect((await fnfRow(employeeId))[0]?.NotRequiredBy).toBe(adminId)
  })

  it('lets a date stand without a name, never a name without a date', async () => {
    const employeeId = await employee()
    const [row] = await fnfRow(employeeId)

    await expect(
      (await createRequest())
        .input('documentId', row?.DocumentId)
        .input('by', adminId)
        .query(`UPDATE dbo.EmployeeDocuments SET NotRequiredAt = NULL, NotRequiredBy = @by
                WHERE DocumentId = @documentId`),
    ).rejects.toThrow(/CK_EmpDocs_NotRequiredBy/)
  })

  it('migration 0041 gives every existing employee one set-aside FNF row, and never two', async () => {
    const a = await employee()
    const b = await employee()
    await leave(b)
    // As if they existed before 0041: no FNF row at all.
    await (await createRequest())
      .input('typeId', fnfTypeId)
      .input('a', a)
      .input('b', b)
      .query(`DELETE FROM dbo.EmployeeDocuments
              WHERE DocumentTypeId = @typeId AND EmployeeId IN (@a, @b)`)

    const file = await readFile(
      new URL('../../../database/migrations/0041_full_and_final_settlement.sql', import.meta.url),
      'utf8',
    )
    const backfill = file
      .split(/^[ \t]*GO[ \t]*(?:--.*)?$/gim)
      .map((batch) => batch.trim())
      .filter((batch) => batch.includes('INSERT INTO dbo.EmployeeDocuments'))
    expect(backfill).toHaveLength(1)

    const printed: string[] = []
    const run = async () => {
      const request = await createRequest()
      request.on('info', (info: { message: string }) => printed.push(info.message))
      await request.batch(backfill[0] as string)
    }
    await run()
    await run()

    for (const employeeId of [a, b]) {
      const rows = await fnfRow(employeeId)
      expect(rows, `employee ${employeeId}`).toHaveLength(1)
      expect(rows[0]).toMatchObject({ NotRequiredBy: null, DueDate: null, Status: 'Pending' })
      expect(rows[0]?.NotRequiredAt).not.toBeNull()
    }
    expect(printed[0]).toMatch(/^FNF: 2 row\(s\) written/)
    expect(printed[1]).toMatch(/^FNF: 0 row\(s\) written/)
  })
})

describe('FNF\'s page, filtered by when the document was uploaded', () => {
  let agent: Awaited<ReturnType<typeof signIn>>
  let fnfTypeId = 0
  let received = 0
  let awaited = 0

  beforeAll(async () => {
    await ensureSchema()
    await resetData()
    agent = await signIn(app(), await createUser('admin.fnfrange', 'ADMIN'))
    const type = await (await createRequest()).query<{ DocumentTypeId: number }>(
      "SELECT DocumentTypeId FROM dbo.DocumentTypes WHERE DocumentCode = 'FNF'",
    )
    fnfTypeId = type.recordset[0]?.DocumentTypeId ?? 0

    // Two employees with FNF marked required: one has sent it today, one not.
    for (const code of ['RNG1', 'RNG2']) {
      const created = await agent
        .post('/api/employees')
        .send({ employeeCode: code, employeeName: 'Ravi Kumar', joiningDate: JOINED })
      const employeeId = created.body.employee.employeeId as number
      const row = await (await createRequest())
        .input('employeeId', employeeId)
        .input('typeId', fnfTypeId)
        .query<{ DocumentId: number }>(`SELECT DocumentId FROM dbo.EmployeeDocuments
            WHERE EmployeeId = @employeeId AND DocumentTypeId = @typeId AND IsActive = 1`)
      const documentId = row.recordset[0]?.DocumentId as number
      if (code === 'RNG1') {
        received = employeeId
        // Uploading onto the set-aside row marks it required (4fbbd42).
        const uploaded = await agent
          .post(`/api/documents/${documentId}/file`)
          .attach('file', await pdf(), { filename: 'fnf.pdf', contentType: 'application/pdf' })
        expect(uploaded.status).toBe(200)
      } else {
        awaited = employeeId
        await (await createRequest())
          .input('documentId', documentId)
          .query('UPDATE dbo.EmployeeDocuments SET NotRequiredAt = NULL, NotRequiredBy = NULL WHERE DocumentId = @documentId')
      }
    }
  })

  afterAll(async () => {
    await closeDatabase()
  })

  const listUrl = (query: string) => `/api/reports/by-document-type/${fnfTypeId}/employees?${query}`

  it('lists what arrived today - and only that, even with outstandingOnly asked for', async () => {
    const today = todayDateOnly()
    const response = await agent.get(listUrl(`uploadedFrom=${today}&uploadedTo=${today}&outstandingOnly=true`))
    expect(response.status).toBe(200)
    const ids = (response.body.rows as { employeeId: number; receivedAt: string | null }[]).map(
      (r) => r.employeeId,
    )
    expect(ids).toEqual([received])
    expect(response.body.rows[0].receivedAt).not.toBeNull()
  })

  it('lists nothing for a day nothing arrived', async () => {
    const yesterday = addDays(todayDateOnly(), -1)
    const response = await agent.get(listUrl(`uploadedFrom=${yesterday}&uploadedTo=${yesterday}`))
    expect(response.status).toBe(200)
    expect(response.body.rows).toEqual([])
  })

  it('lists the awaited one again once the range is cleared, with no received date', async () => {
    const response = await agent.get(listUrl('outstandingOnly=true'))
    const rows = response.body.rows as { employeeId: number; receivedAt: string | null }[]
    expect(rows.map((r) => r.employeeId)).toEqual([awaited])
    expect(rows[0]?.receivedAt).toBeNull()
  })

  it('gives the spreadsheet and the printed list the same range', async () => {
    const today = todayDateOnly()
    const all = await agent.get(
      `/api/reports/by-document-type/${fnfTypeId}/employees/all?uploadedFrom=${today}&uploadedTo=${today}`,
    )
    expect(all.status).toBe(200)
    expect((all.body.rows as { employeeId: number }[]).map((r) => r.employeeId)).toEqual([received])

    const printed = await agent
      .get(`/api/reports/by-document-type/${fnfTypeId}/employees/print?uploadedFrom=${today}&uploadedTo=${today}`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => done(null, Buffer.concat(chunks)))
      })
    expect(printed.status).toBe(200)
    expect(printed.headers['content-type']).toContain('application/pdf')
  })

  it('refuses a range that ends before it starts', async () => {
    const response = await agent.get(listUrl('uploadedFrom=2026-10-30&uploadedTo=2026-10-29'))
    expect(response.status).toBe(400)
  })
})
