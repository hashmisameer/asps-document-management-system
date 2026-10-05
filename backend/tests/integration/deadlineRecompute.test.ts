import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, todayDateOnly } from '@asps-dms/shared'
import { createRequest } from '../../src/database/pool.js'
import * as employeeDocumentRepository from '../../src/repositories/employeeDocument.repository.js'
import { applyMoves, planForEveryone } from '../../src/services/deadlineRecompute.service.js'
import { app, closeDatabase, createUser, ensureSchema, resetData, signIn } from './helpers.js'

/**
 * Deadlines following the joining date, against a real database.
 *
 * What only the database can prove: which ROWS the recompute offers up. The
 * arithmetic is pinned in the unit tests; the query is the part that has to
 * leave a document with a file alone, pick up one marked 'not required', and
 * find an employee whose dates disagree without being told which employee.
 */

const JOINED = addDays(todayDateOnly(), -3)
const CORRECTED = addDays(todayDateOnly(), -10)

let codeSeq = 0

describe('deadlines follow the joining date, end to end', () => {
  beforeAll(async () => {
    await ensureSchema()
    await resetData()
  })

  afterAll(async () => {
    await closeDatabase()
  })

  /** A new employee, their checklist, and an administrator to edit them. */
  async function employee() {
    const admin = await createUser(`admin.deadline${++codeSeq}`, 'ADMIN')
    const agent = await signIn(app(), admin)
    const created = await agent
      .post('/api/employees')
      .send({ employeeCode: `DL${codeSeq}`, employeeName: 'Ravi Kumar', joiningDate: JOINED })
    expect(created.status).toBe(201)
    return { agent, admin, profile: created.body.employee }
  }

  const dueDates = async (employeeId: number) => {
    const request = await createRequest()
    const result = await request.query<{ DocumentCode: string; DueDate: string | null }>(
      `SELECT dt.DocumentCode, CONVERT(VARCHAR(10), d.DueDate, 120) AS DueDate
       FROM dbo.EmployeeDocuments d JOIN dbo.DocumentTypes dt ON dt.DocumentTypeId = d.DocumentTypeId
       WHERE d.EmployeeId = ${employeeId} AND d.IsActive = 1`,
    )
    return new Map(result.recordset.map((row) => [row.DocumentCode, row.DueDate]))
  }

  it('moves every outstanding deadline when the joining date is corrected, and reports how many', async () => {
    const { agent, profile } = await employee()
    const before = await dueDates(profile.employeeId)
    expect(before.get('PF_FORM')).toBe(addDays(JOINED, 12))

    const saved = await agent
      .patch(`/api/employees/${profile.employeeId}`)
      .send({ joiningDate: CORRECTED })
    expect(saved.status).toBe(200)
    expect(saved.body.employee.joiningDate).toBe(CORRECTED)
    // Nine checklist rows, every one of them outstanding, every one moved.
    expect(saved.body.deadlinesMoved).toBeGreaterThan(0)

    const after = await dueDates(profile.employeeId)
    expect(after.get('PF_FORM')).toBe(addDays(CORRECTED, 12))
    expect(after.get('APPOINTMENT_LETTER')).toBe(addDays(CORRECTED, 7))

    // One DEADLINE_CHANGED entry per document moved, saying what moved it.
    const request = await createRequest()
    const trail = await request.query<{ N: number; Metadata: string }>(
      `SELECT COUNT(*) AS N, MIN(Metadata) AS Metadata FROM dbo.AuditLogs
       WHERE Action = 'DEADLINE_CHANGED' AND EntityId IN (
         SELECT CAST(DocumentId AS VARCHAR(50)) FROM dbo.EmployeeDocuments WHERE EmployeeId = ${profile.employeeId})`,
    )
    expect(trail.recordset[0]?.N).toBe(saved.body.deadlinesMoved)
    expect(JSON.parse(trail.recordset[0]?.Metadata ?? '{}')).toMatchObject({
      reason: `joining date changed from ${JOINED} to ${CORRECTED}`,
    })
  })

  it('leaves a document that has already arrived on the date that applied to it', async () => {
    const { agent, profile } = await employee()
    const checklist = await agent.get(`/api/employees/${profile.employeeId}/documents`)
    const target = checklist.body.documents.find(
      (d: { documentCode: string }) => d.documentCode === 'BIO_DATA',
    )

    const pdf = await PDFDocument.create()
    pdf.addPage([595.28, 841.89])
    const upload = await agent
      .post(`/api/documents/${target.documentId}/file`)
      .attach('file', Buffer.from(await pdf.save()), {
        filename: 'bio.pdf',
        contentType: 'application/pdf',
      })
    expect(upload.status).toBe(200)
    const before = await dueDates(profile.employeeId)

    const saved = await agent
      .patch(`/api/employees/${profile.employeeId}`)
      .send({ joiningDate: CORRECTED })
    expect(saved.status).toBe(200)

    const after = await dueDates(profile.employeeId)
    // The one with a file kept its date; its neighbours moved.
    expect(after.get('BIO_DATA')).toBe(before.get('BIO_DATA'))
    expect(after.get('APPOINTMENT_LETTER')).toBe(addDays(CORRECTED, 7))
  })

  it('moves the deadline of a document marked not required, which nothing shows but nothing should contradict', async () => {
    const { agent, admin, profile } = await employee()
    const checklist = await agent.get(`/api/employees/${profile.employeeId}/documents`)
    const esic = checklist.body.documents.find(
      (d: { documentCode: string }) => d.documentCode === 'ESIC_FORM',
    )

    // Marked not required in the table rather than through the route: what is
    // being tested is which rows the RECOMPUTE picks up, and the route that
    // sets this flag has its own tests. Both columns, because
    // CK_EmpDocs_NotRequired requires the pair.
    const request = await createRequest()
    await request.query(
      `UPDATE dbo.EmployeeDocuments
          SET NotRequiredAt = SYSUTCDATETIME(), NotRequiredBy = ${admin.userId}
        WHERE DocumentId = ${esic.documentId}`,
    )

    await agent.patch(`/api/employees/${profile.employeeId}`).send({ joiningDate: CORRECTED })

    const after = await dueDates(profile.employeeId)
    expect(after.get('ESIC_FORM')).toBe(addDays(CORRECTED, 12))
  })

  it('changes nothing when the joining date is saved unchanged', async () => {
    const { agent, profile } = await employee()
    const before = await dueDates(profile.employeeId)

    const saved = await agent
      .patch(`/api/employees/${profile.employeeId}`)
      .send({ joiningDate: JOINED, department: 'Stitching' })
    expect(saved.status).toBe(200)
    expect(saved.body.deadlinesMoved).toBe(0)
    expect(await dueDates(profile.employeeId)).toEqual(before)
  })

  describe('the sweep', () => {
    it('finds an employee whose dates were left behind, changes nothing on a dry run, and puts them right on a live one', async () => {
      await resetData()
      const { admin, profile } = await employee()

      // The state the three real records were in: the joining date was
      // corrected while nothing moved the deadlines with it.
      const request = await createRequest()
      await request.query(
        `UPDATE dbo.EmployeeDocuments SET DueDate = '1988-09-14'
         WHERE EmployeeId = ${profile.employeeId} AND IsActive = 1`,
      )

      const planned = await planForEveryone(500)
      expect(planned.length).toBeGreaterThan(0)
      expect(planned.every((move) => move.employeeCode === profile.employeeCode)).toBe(true)
      expect(planned.every((move) => move.from === '1988-09-14')).toBe(true)

      // The plan is read-only: that is what makes --dry-run honest.
      const stillWrong = await dueDates(profile.employeeId)
      expect([...stillWrong.values()].every((date) => date === '1988-09-14')).toBe(true)

      const written = await applyMoves(planned, {
        actor: {
          userId: admin.userId,
          username: admin.username,
          fullName: 'Administrator',
          role: 'ADMIN',
          mustChangePassword: false,
        },
        context: { ipAddress: null, userAgent: 'test' },
        reason: 'recomputed from the employee’s joining date',
      })
      expect(written).toBe(planned.length)

      const fixed = await dueDates(profile.employeeId)
      expect(fixed.get('APPOINTMENT_LETTER')).toBe(addDays(JOINED, 7))
      expect(fixed.get('PF_FORM')).toBe(addDays(JOINED, 12))

      // And nothing is left to do - the sweep is idempotent.
      expect(await planForEveryone(500)).toEqual([])
    })

    it('says which deadlines had been set by hand before it overwrote them', async () => {
      await resetData()
      const { agent, profile } = await employee()
      const checklist = await agent.get(`/api/employees/${profile.employeeId}/documents`)
      const target = checklist.body.documents.find(
        (d: { documentCode: string }) => d.documentCode === 'PAN_CARD',
      )

      // HR extends one deadline deliberately - which writes DEADLINE_CHANGED.
      const extended = await agent
        .patch(`/api/documents/${target.documentId}/deadline`)
        .send({ dueDate: addDays(todayDateOnly(), 30), reason: 'card is being reissued' })
      expect(extended.status).toBe(200)

      const planned = await planForEveryone(500)
      const pan = planned.find((move) => move.documentId === target.documentId)
      expect(pan).toBeDefined()
      expect(pan?.wasOverridden).toBe(true)
      // Nothing else was touched by hand, so nothing else claims to have been.
      expect(planned.filter((move) => move.wasOverridden)).toHaveLength(1)
    })

    it('offers nothing up once every outstanding document agrees with its joining date', async () => {
      await resetData()
      await employee()
      expect(await planForEveryone(500)).toEqual([])
      expect(await employeeDocumentRepository.listAllDeadlineCandidates(500)).not.toHaveLength(0)
    })
  })
})
