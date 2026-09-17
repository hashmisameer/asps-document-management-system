import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SIGNER_ROLES } from '@asps-dms/shared'
import * as documentTypePlacementRepository from '../../src/repositories/documentTypePlacement.repository.js'
import * as documentTypeRepository from '../../src/repositories/documentType.repository.js'
import * as signaturePlacementRepository from '../../src/repositories/signaturePlacement.repository.js'
import { createRequest } from '../../src/database/pool.js'
import { app, closeDatabase, createUser, ensureSchema, resetData, signIn } from './helpers.js'

/**
 * Placement templates, against the real table and its real CHECK constraints.
 *
 * A template is written through the real repository into the migrated table
 * and read back; the constraints that must still refuse a bad box are
 * exercised; and the thing the whole change promises is asserted directly:
 * saving a template writes nothing to SignaturePlacements or EmployeeDocuments.
 */

const A4 = { pageWidthPt: 595.28, pageHeightPt: 841.89 }

const BOX = {
  pageNumber: 1,
  x: 0.6,
  y: 0.8,
  width: 0.28,
  height: 0.09,
  pageRotation: 0,
  ...A4,
}

describe('placement templates, in the database', () => {
  let adminUserId = 0
  let esicTypeId = 0
  let gratuityTypeId = 0
  let esicDocumentId = 0

  beforeAll(async () => {
    await ensureSchema()
    await resetData()

    const admin = await createUser('admin.templates', 'ADMIN')
    adminUserId = admin.userId

    const types = await documentTypeRepository.listActive()
    esicTypeId = types.find((t) => t.documentCode === 'ESIC_FORM')?.documentTypeId ?? 0
    gratuityTypeId = types.find((t) => t.documentCode === 'GRATUITY_FORM')?.documentTypeId ?? 0
    expect(esicTypeId).toBeGreaterThan(0)
    expect(gratuityTypeId).toBeGreaterThan(0)

    // One employee with a checklist, so there is a document to name as the sample.
    const agent = await signIn(app(), admin)
    const created = await agent
      .post('/api/employees')
      .send({ employeeCode: 'TMPL0001', employeeName: 'Sample Person', joiningDate: '2026-04-01' })
    expect(created.status).toBe(201)
    const checklist = await agent.get(`/api/employees/${created.body.employee.employeeId}/documents`)
    esicDocumentId = checklist.body.documents.find(
      (d: { documentCode: string }) => d.documentCode === 'ESIC_FORM',
    ).documentId
  })

  afterAll(async () => {
    await closeDatabase()
  })

  async function countRows(table: string): Promise<number> {
    const request = await createRequest()
    const result = await request.query<{ N: number }>(`SELECT COUNT(*) AS N FROM dbo.${table}`)
    return result.recordset[0]?.N ?? 0
  }

  it('stores a template with all three roles and reads it back', async () => {
    await documentTypePlacementRepository.replaceForType(
      esicTypeId,
      [
        { ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE },
        { ...BOX, signerRole: SIGNER_ROLES.AUTHORISER, y: 0.6 },
        { ...BOX, signerRole: SIGNER_ROLES.PHOTO, x: 0.76, y: 0.06, width: 0.16, height: 0.14 },
      ],
      { documentId: esicDocumentId, pageCount: 1 },
      adminUserId,
    )

    const rows = await documentTypePlacementRepository.listForType(esicTypeId)
    expect(rows.map((r) => r.signerRole).sort()).toEqual(['Authoriser', 'Employee', 'Photo'])
    expect(rows[0]).toMatchObject({
      documentTypeId: esicTypeId,
      pageRotation: 0,
      samplePageCount: 1,
      sampleDocumentId: esicDocumentId,
      createdByName: 'admin.templates test',
    })
    expect(rows[0]?.pageWidthPt).toBeCloseTo(A4.pageWidthPt, 2)
  })

  it('keeps several boxes of one role on one page - the gratuity form signs in three places', async () => {
    await documentTypePlacementRepository.replaceForType(
      gratuityTypeId,
      [
        { ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, y: 0.3 },
        { ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, y: 0.5 },
        { ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, y: 0.7 },
        { ...BOX, signerRole: SIGNER_ROLES.AUTHORISER, y: 0.85, x: 0.1 },
        { ...BOX, signerRole: SIGNER_ROLES.AUTHORISER, y: 0.85, x: 0.5 },
      ],
      { documentId: null, pageCount: 2 },
      adminUserId,
    )

    const rows = await documentTypePlacementRepository.listForType(gratuityTypeId)
    expect(rows.filter((r) => r.signerRole === 'Employee')).toHaveLength(3)
    expect(rows.filter((r) => r.signerRole === 'Authoriser')).toHaveLength(2)
  })

  it('never writes a document placement or touches a document row', async () => {
    const placementsBefore = await countRows('SignaturePlacements')
    const documentsBefore = await countRows('EmployeeDocuments')
    const request = await createRequest()
    const stamp = await request.query<{ U: Date }>(
      'SELECT MAX(UpdatedAt) AS U FROM dbo.EmployeeDocuments',
    )

    await documentTypePlacementRepository.replaceForType(
      esicTypeId,
      [{ ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE }],
      { documentId: esicDocumentId, pageCount: 1 },
      adminUserId,
    )

    expect(await countRows('SignaturePlacements')).toBe(placementsBefore)
    expect(await countRows('EmployeeDocuments')).toBe(documentsBefore)
    const after = await (await createRequest()).query<{ U: Date }>(
      'SELECT MAX(UpdatedAt) AS U FROM dbo.EmployeeDocuments',
    )
    expect(after.recordset[0]?.U?.getTime()).toBe(stamp.recordset[0]?.U?.getTime())
    // And the sample document's own placements are untouched: it has none.
    expect(await signaturePlacementRepository.listForDocument(esicDocumentId)).toEqual([])
  })

  it('removes the template when given nothing', async () => {
    await documentTypePlacementRepository.replaceForType(gratuityTypeId, [], { documentId: null, pageCount: 1 }, adminUserId)
    expect(await documentTypePlacementRepository.listForType(gratuityTypeId)).toEqual([])
  })

  it('refuses a box off the page, on page zero, or on a page the sample lacks', async () => {
    const sample = { documentId: null, pageCount: 1 }
    await expect(
      documentTypePlacementRepository.replaceForType(
        esicTypeId,
        [{ ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, x: 0.9, width: 0.3 }],
        sample,
        adminUserId,
      ),
    ).rejects.toMatchObject({ number: 547 })
    await expect(
      documentTypePlacementRepository.replaceForType(
        esicTypeId,
        [{ ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, pageNumber: 0 }],
        sample,
        adminUserId,
      ),
    ).rejects.toMatchObject({ number: 547 })
    await expect(
      documentTypePlacementRepository.replaceForType(
        esicTypeId,
        [{ ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, pageNumber: 2 }],
        sample,
        adminUserId,
      ),
    ).rejects.toMatchObject({ number: 547 })
  })

  it('leaves the previous template in place when the new one is refused', async () => {
    await documentTypePlacementRepository.replaceForType(
      esicTypeId,
      [{ ...BOX, signerRole: SIGNER_ROLES.PHOTO }],
      { documentId: null, pageCount: 1 },
      adminUserId,
    )
    await expect(
      documentTypePlacementRepository.replaceForType(
        esicTypeId,
        [{ ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, pageRotation: 45 }],
        { documentId: null, pageCount: 1 },
        adminUserId,
      ),
    ).rejects.toMatchObject({ number: 547 })

    const rows = await documentTypePlacementRepository.listForType(esicTypeId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.signerRole).toBe('Photo')
  })

  it('summarises every active type, set or not, and knows the scanned cards', async () => {
    const summaries = await documentTypePlacementRepository.summaries()
    const byCode = Object.fromEntries(summaries.map((s) => [s.documentCode, s]))

    expect(byCode.ESIC_FORM).toMatchObject({ status: 'set', boxes: 1, roles: { Photo: 1 }, pages: 1 })
    expect(byCode.ESIC_FORM?.setByName).toBe('admin.templates test')
    expect(byCode.GRATUITY_FORM).toMatchObject({ status: 'unset', boxes: 0 })
    expect(byCode.AADHAAR_CARD).toMatchObject({ status: 'scanned' })
    expect(byCode.PAN_CARD).toMatchObject({ status: 'scanned' })
    expect(summaries).toHaveLength(9)
  })
})
