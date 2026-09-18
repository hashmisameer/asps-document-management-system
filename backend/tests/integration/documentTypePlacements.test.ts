import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SIGNER_ROLES, type TemplateVariant } from '@asps-dms/shared'
import * as documentTypePlacementRepository from '../../src/repositories/documentTypePlacement.repository.js'
import * as documentTypeRepository from '../../src/repositories/documentType.repository.js'
import * as signaturePlacementRepository from '../../src/repositories/signaturePlacement.repository.js'
import { createRequest } from '../../src/database/pool.js'
import { app, closeDatabase, createUser, ensureSchema, resetData, signIn } from './helpers.js'

/**
 * Placement templates, against the real table and its real CHECK constraints.
 *
 * A type holds one template PER VARIANT - 'PF Form / Form 11' is a two-page
 * form and a one-page form, and each gets its own boxes. Both are written
 * through the real repository into the migrated table and read back; saving
 * one leaves the other alone; the constraints that must still refuse a bad
 * box are exercised; and the thing the whole change promises is asserted
 * directly: saving a template writes nothing to SignaturePlacements or
 * EmployeeDocuments.
 */

const A4 = { pageWidthPt: 595.28, pageHeightPt: 841.89 }
const PF_TWO_PAGE: TemplateVariant = { pageCount: 2, widthPt: 595, heightPt: 842 }
const FORM_11: TemplateVariant = { pageCount: 1, widthPt: 595, heightPt: 842 }

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
  let pfTypeId = 0
  let esicDocumentId = 0

  beforeAll(async () => {
    await ensureSchema()
    await resetData()

    const admin = await createUser('admin.templates', 'ADMIN')
    adminUserId = admin.userId

    const types = await documentTypeRepository.listActive()
    esicTypeId = types.find((t) => t.documentCode === 'ESIC_FORM')?.documentTypeId ?? 0
    pfTypeId = types.find((t) => t.documentCode === 'PF_FORM')?.documentTypeId ?? 0
    expect(esicTypeId).toBeGreaterThan(0)
    expect(pfTypeId).toBeGreaterThan(0)

    const agent = await signIn(app(), admin)
    const created = await agent
      .post('/api/employees')
      .send({ employeeCode: 'TMPL0001', employeeName: 'Sample Person', joiningDate: '2026-04-01' })
    expect(created.status).toBe(201)
    const checklist = await agent.get(
      `/api/employees/${created.body.employee.employeeId}/documents`,
    )
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

  it('stores a template with all three roles and reads it back with its variant', async () => {
    await documentTypePlacementRepository.replaceForVariant(
      esicTypeId,
      FORM_11,
      [
        { ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE },
        { ...BOX, signerRole: SIGNER_ROLES.AUTHORISER, y: 0.6 },
        { ...BOX, signerRole: SIGNER_ROLES.PHOTO, x: 0.76, y: 0.06, width: 0.16, height: 0.14 },
      ],
      esicDocumentId,
      adminUserId,
    )

    const rows = await documentTypePlacementRepository.listForType(esicTypeId)
    expect(rows.map((r) => r.signerRole).sort()).toEqual(['Authoriser', 'Employee', 'Photo'])
    expect(rows[0]).toMatchObject({
      documentTypeId: esicTypeId,
      pageRotation: 0,
      variant: FORM_11,
      sampleDocumentId: esicDocumentId,
      createdByName: 'admin.templates test',
    })
    expect(rows[0]?.pageWidthPt).toBeCloseTo(A4.pageWidthPt, 2)
  })

  it('holds two forms of one type side by side - the PF form and Form 11', async () => {
    await documentTypePlacementRepository.replaceForVariant(
      pfTypeId,
      PF_TWO_PAGE,
      [
        { ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, pageNumber: 1 },
        { ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, pageNumber: 2, y: 0.5 },
        { ...BOX, signerRole: SIGNER_ROLES.AUTHORISER, pageNumber: 2, y: 0.85 },
      ],
      null,
      adminUserId,
    )
    await documentTypePlacementRepository.replaceForVariant(
      pfTypeId,
      FORM_11,
      [
        { ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, y: 0.7 },
        { ...BOX, signerRole: SIGNER_ROLES.AUTHORISER, y: 0.85 },
      ],
      null,
      adminUserId,
    )

    const rows = await documentTypePlacementRepository.listForType(pfTypeId)
    const twoPage = rows.filter((r) => r.variant.pageCount === 2)
    const onePage = rows.filter((r) => r.variant.pageCount === 1)
    expect(twoPage).toHaveLength(3)
    expect(onePage).toHaveLength(2)
    expect(twoPage.some((r) => r.pageNumber === 2)).toBe(true)
  })

  it('replaces one variant and leaves the other exactly as it was', async () => {
    const before = (await documentTypePlacementRepository.listForType(pfTypeId)).filter(
      (r) => r.variant.pageCount === 2,
    )

    expect(await documentTypePlacementRepository.variantExists(pfTypeId, FORM_11)).toBe(true)
    await documentTypePlacementRepository.replaceForVariant(
      pfTypeId,
      FORM_11,
      [{ ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, y: 0.75 }],
      null,
      adminUserId,
    )

    const rows = await documentTypePlacementRepository.listForType(pfTypeId)
    expect(rows.filter((r) => r.variant.pageCount === 1)).toHaveLength(1)
    const after = rows.filter((r) => r.variant.pageCount === 2)
    expect(after.map((r) => r.documentTypePlacementId)).toEqual(
      before.map((r) => r.documentTypePlacementId),
    )
  })

  it('replaces by SHAPE: a save on a 596x841 sample takes over the 595x842 template', async () => {
    // The template saved on 595x842 above. A re-export of the same form, a
    // point off each way, is the same shape - and a save on it must replace
    // that template, not sit beside it and make the form ambiguous.
    const resaved = { pageCount: 1, widthPt: 596, heightPt: 841 }
    expect(await documentTypePlacementRepository.variantExists(pfTypeId, resaved)).toBe(true)

    await documentTypePlacementRepository.replaceForVariant(
      pfTypeId,
      resaved,
      [
        { ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, y: 0.6, pageWidthPt: 596, pageHeightPt: 841 },
        {
          ...BOX,
          signerRole: SIGNER_ROLES.AUTHORISER,
          y: 0.8,
          pageWidthPt: 596,
          pageHeightPt: 841,
        },
      ],
      null,
      adminUserId,
    )

    const rows = await documentTypePlacementRepository.listForType(pfTypeId)
    const onePage = rows.filter((r) => r.variant.pageCount === 1)
    // Exactly the new set, keyed on the new sample; the old key is gone.
    expect(onePage).toHaveLength(2)
    expect(onePage.every((r) => r.variant.widthPt === 596 && r.variant.heightPt === 841)).toBe(true)
    // The two-page form is a different shape and untouched.
    expect(rows.filter((r) => r.variant.pageCount === 2)).toHaveLength(3)

    // A Letter-shaped sample is NOT this shape, so a save on it sits beside.
    const letter = { pageCount: 1, widthPt: 612, heightPt: 792 }
    expect(await documentTypePlacementRepository.variantExists(pfTypeId, letter)).toBe(false)
  })

  it('never writes a document placement or touches a document row', async () => {
    const placementsBefore = await countRows('SignaturePlacements')
    const documentsBefore = await countRows('EmployeeDocuments')
    const request = await createRequest()
    const stamp = await request.query<{ U: Date }>(
      'SELECT MAX(UpdatedAt) AS U FROM dbo.EmployeeDocuments',
    )

    await documentTypePlacementRepository.replaceForVariant(
      esicTypeId,
      FORM_11,
      [{ ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE }],
      esicDocumentId,
      adminUserId,
    )

    expect(await countRows('SignaturePlacements')).toBe(placementsBefore)
    expect(await countRows('EmployeeDocuments')).toBe(documentsBefore)
    const after = await (
      await createRequest()
    ).query<{ U: Date }>('SELECT MAX(UpdatedAt) AS U FROM dbo.EmployeeDocuments')
    expect(after.recordset[0]?.U?.getTime()).toBe(stamp.recordset[0]?.U?.getTime())
    expect(await signaturePlacementRepository.listForDocument(esicDocumentId)).toEqual([])
  })

  it('removes one variant when given nothing, and the other stays', async () => {
    await documentTypePlacementRepository.replaceForVariant(
      pfTypeId,
      FORM_11,
      [],
      null,
      adminUserId,
    )
    const rows = await documentTypePlacementRepository.listForType(pfTypeId)
    expect(rows.every((r) => r.variant.pageCount === 2)).toBe(true)
    expect(rows).toHaveLength(3)
    expect(await documentTypePlacementRepository.variantExists(pfTypeId, FORM_11)).toBe(false)
  })

  it('refuses a box off the page, on page zero, or on a page the sample lacks', async () => {
    await expect(
      documentTypePlacementRepository.replaceForVariant(
        esicTypeId,
        FORM_11,
        [{ ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, x: 0.9, width: 0.3 }],
        null,
        adminUserId,
      ),
    ).rejects.toMatchObject({ number: 547 })
    await expect(
      documentTypePlacementRepository.replaceForVariant(
        esicTypeId,
        FORM_11,
        [{ ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, pageNumber: 0 }],
        null,
        adminUserId,
      ),
    ).rejects.toMatchObject({ number: 547 })
    await expect(
      documentTypePlacementRepository.replaceForVariant(
        esicTypeId,
        FORM_11,
        [{ ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, pageNumber: 2 }],
        null,
        adminUserId,
      ),
    ).rejects.toMatchObject({ number: 547 })
  })

  it('leaves the previous template in place when the new one is refused', async () => {
    await documentTypePlacementRepository.replaceForVariant(
      esicTypeId,
      FORM_11,
      [{ ...BOX, signerRole: SIGNER_ROLES.PHOTO }],
      null,
      adminUserId,
    )
    await expect(
      documentTypePlacementRepository.replaceForVariant(
        esicTypeId,
        FORM_11,
        [{ ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, pageRotation: 45 }],
        null,
        adminUserId,
      ),
    ).rejects.toMatchObject({ number: 547 })

    const rows = await documentTypePlacementRepository.listForType(esicTypeId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.signerRole).toBe('Photo')
  })

  it('summarises every active type with each of its forms, and knows the scanned cards', async () => {
    const summaries = await documentTypePlacementRepository.summaries()
    const byCode = Object.fromEntries(summaries.map((s) => [s.documentCode, s]))

    expect(byCode.ESIC_FORM).toMatchObject({ status: 'set' })
    expect(byCode.ESIC_FORM?.variants).toHaveLength(1)
    expect(byCode.ESIC_FORM?.variants[0]).toMatchObject({
      variant: FORM_11,
      boxes: 1,
      roles: { Photo: 1 },
      pages: 1,
      setByName: 'admin.templates test',
    })
    expect(byCode.PF_FORM?.variants.map((v) => v.variant.pageCount)).toEqual([2])
    expect(byCode.GRATUITY_FORM).toMatchObject({ status: 'unset', variants: [] })
    expect(byCode.AADHAAR_CARD).toMatchObject({ status: 'scanned', variants: [] })
    expect(byCode.PAN_CARD).toMatchObject({ status: 'scanned' })
    expect(summaries).toHaveLength(9)
  })
})
