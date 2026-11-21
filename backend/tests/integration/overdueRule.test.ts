import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, todayDateOnly, tracksOverdue } from '@asps-dms/shared'
import { createRequest } from '../../src/database/pool.js'
import { app, closeDatabase, createUser, ensureSchema, resetData, signIn } from './helpers.js'

/**
 * Which types can be late, against the real routes.
 *
 * The rule is tracksOverdue(type): a type with a deadline can be late. The
 * report page reads it off the type GET /api/document-types hands it - so the
 * deadline has to ARRIVE there. Lost on the way, it would be undefined, and
 * every type would quietly stop showing overdue. The declaration cannot catch
 * that; this does. The printed list reads the same rule on the server.
 */

const JOINED = addDays(todayDateOnly(), -3)

/** Reads the words back out of a generated PDF, all pages as one string. */
async function textOf(pdf: Buffer): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const parsed = await getDocument({
    data: new Uint8Array(pdf),
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise
  try {
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= parsed.numPages; pageNumber += 1) {
      const content = await (await parsed.getPage(pageNumber)).getTextContent()
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
    }
    return pages.join(' ')
  } finally {
    await parsed.destroy()
  }
}

describe('which types track overdue', () => {
  let agent: Awaited<ReturnType<typeof signIn>>
  const typeIds = new Map<string, number>()

  beforeAll(async () => {
    await ensureSchema()
    await resetData()
    agent = await signIn(app(), await createUser('admin.deadlines', 'ADMIN'))
    const types = await (await createRequest()).query<{ DocumentTypeId: number; DocumentCode: string }>(
      'SELECT DocumentTypeId, DocumentCode FROM dbo.DocumentTypes',
    )
    for (const type of types.recordset) typeIds.set(type.DocumentCode, type.DocumentTypeId)
  })

  afterAll(async () => {
    await closeDatabase()
  })

  it('hands the page every type with its deadline, so the rule has something to read', async () => {
    const res = await agent.get('/api/document-types')
    expect(res.status).toBe(200)

    const types = res.body.documentTypes as Array<{ documentCode: string; isMandatory: boolean; deadlineValue?: number | null }>
    expect(types.length).toBeGreaterThan(0)
    for (const type of types) {
      // Present on every type, a number or null - never missing.
      expect('deadlineValue' in type, type.documentCode).toBe(true)
      expect(type.deadlineValue === null || typeof type.deadlineValue === 'number', type.documentCode).toBe(true)
    }

    const byCode = (code: string) => types.find((type) => type.documentCode === code)
    for (const code of ['ESIC_FORM', 'PF_FORM']) {
      const type = byCode(code)
      expect(type?.deadlineValue, code).toBe(12)
      expect(type?.isMandatory, `${code} stays optional`).toBe(false)
      expect(tracksOverdue(type as { deadlineValue: number | null }), code).toBe(true)
    }
    const fnf = byCode('FNF')
    expect(fnf?.deadlineValue).toBeNull()
    expect(tracksOverdue(fnf as { deadlineValue: number | null })).toBe(false)
  })

  /** One employee whose row of this type is expected and fell due 5 days ago. */
  async function lateRow(code: string, employeeCode: string): Promise<number> {
    const created = await agent
      .post('/api/employees')
      .send({ employeeCode, employeeName: 'Ravi Kumar', joiningDate: JOINED })
    expect(created.status).toBe(201)
    const typeId = typeIds.get(code) ?? 0
    // FNF starts set aside; it is put back on the list here, with a past due
    // date it would never really have, so only the rule can keep it from
    // reading as late.
    // Read back rather than trusting rowsAffected, which SET NOCOUNT hides here.
    const updated = await (await createRequest())
      .input('employeeId', created.body.employee.employeeId as number)
      .input('typeId', typeId)
      .input('due', addDays(todayDateOnly(), -5))
      .query<{ Late: number }>(`UPDATE dbo.EmployeeDocuments
              SET DueDate = @due, NotRequiredAt = NULL, NotRequiredBy = NULL
              WHERE EmployeeId = @employeeId AND DocumentTypeId = @typeId AND IsActive = 1;
              SELECT COUNT(*) AS Late FROM dbo.EmployeeDocuments
              WHERE EmployeeId = @employeeId AND DocumentTypeId = @typeId AND IsActive = 1
                AND DueDate = @due AND NotRequiredAt IS NULL AND OriginalFilePath IS NULL`)
    expect(updated.recordset[0]?.Late).toBe(1)
    return typeId
  }

  async function printed(typeId: number): Promise<string> {
    const res = await agent
      .get(`/api/reports/by-document-type/${typeId}/employees/print`)
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => done(null, Buffer.concat(chunks)))
      })
    expect(res.status).toBe(200)
    return textOf(res.body as Buffer)
  }

  it('prints a late ESIC row as Overdue, with its days - though ESIC is optional', async () => {
    const text = await printed(await lateRow('ESIC_FORM', 'OVD1'))
    expect(text).toContain('OVD1')
    expect(text).toContain('Overdue')
    expect(text).toContain('5 overdue')
  })

  it('never prints an FNF row as Overdue, whatever its date says', async () => {
    const text = await printed(await lateRow('FNF', 'OVD2'))
    expect(text).toContain('OVD2')
    expect(text).not.toContain('Overdue')
    expect(text).not.toContain('overdue')
  })
})
