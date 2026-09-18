import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SIGNER_ROLES, addDays, todayDateOnly } from '@asps-dms/shared'
import * as signaturePlacementRepository from '../../src/repositories/signaturePlacement.repository.js'
import { app, closeDatabase, createUser, ensureSchema, resetData, signIn } from './helpers.js'

/**
 * Placement rows, against the real table and its real CHECK constraints.
 *
 * The unit tests mock the repository, and they passed while production refused
 * every photograph placement at the INSERT: 0032 widened one constraint on the
 * row and missed its sibling, CK_SigPlace_SignerUser, which had no branch for a
 * role that names no signer. Nothing short of the database can catch that
 * class of mistake, so this file writes every role the application can send
 * into the migrated table and reads it back.
 *
 * Three roles, three rules the database holds:
 *   Employee    names no signer
 *   Authoriser  names the user who signed
 *   Photo       names no signer - it is a picture, not anybody's signature
 */

const BOX = {
  pageNumber: 1,
  x: 0.7,
  y: 0.1,
  width: 0.2,
  height: 0.15,
  pageRotation: 0,
  method: 'Manual' as const,
  detectionMethod: 'Manual' as const,
  confidence: null,
}

describe('signature placements, in the database', () => {
  let hrUserId = 0
  let employeeId = 0
  let esicDocumentId = 0

  beforeAll(async () => {
    await ensureSchema()
    await resetData()

    const hr = await createUser('hr.placements', 'HR')
    hrUserId = hr.userId
    const agent = await signIn(app(), hr)

    const created = await agent.post('/api/employees').send({
      employeeCode: 'PLACE1',
      employeeName: 'Ravi Kumar Gaur',
      // Three days ago, not a fixed date: HR may only add somebody who joined
      // within the last week, and a date written here would fall out of it.
      joiningDate: addDays(todayDateOnly(), -3),
    })
    expect(created.status).toBe(201)
    employeeId = created.body.employee.employeeId

    const checklist = await agent.get(`/api/employees/${employeeId}/documents`)
    const esic = checklist.body.documents.find(
      (d: { documentCode: string }) => d.documentCode === 'ESIC_FORM',
    )
    expect(esic).toBeDefined()
    esicDocumentId = esic.documentId
  })

  afterAll(async () => {
    await closeDatabase()
  })

  it('accepts a photograph box that names no signer', async () => {
    // The row production refused: SignerRole 'Photo', SignerUserId NULL.
    await signaturePlacementRepository.replaceForDocument(
      esicDocumentId,
      employeeId,
      [{ ...BOX, signerRole: SIGNER_ROLES.PHOTO, signerUserId: null }],
      hrUserId,
    )

    const rows = await signaturePlacementRepository.listForDocument(esicDocumentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      documentId: esicDocumentId,
      employeeId,
      signerRole: SIGNER_ROLES.PHOTO,
      signerUserId: null,
      pageNumber: 1,
    })
  })

  it('keeps a photograph beside the two signatures on one document', async () => {
    await signaturePlacementRepository.replaceForDocument(
      esicDocumentId,
      employeeId,
      [
        { ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, signerUserId: null, y: 0.8 },
        { ...BOX, signerRole: SIGNER_ROLES.AUTHORISER, signerUserId: hrUserId, y: 0.6 },
        { ...BOX, signerRole: SIGNER_ROLES.PHOTO, signerUserId: null },
      ],
      hrUserId,
    )

    const rows = await signaturePlacementRepository.listForDocument(esicDocumentId)
    expect(rows.map((row) => row.signerRole).sort()).toEqual(['Authoriser', 'Employee', 'Photo'])
  })

  it('still refuses a photograph box that claims a signer', async () => {
    // A picture is nobody's signature; a user id on it would be a claim
    // nothing reads and nobody could trust. The constraint keeps that true.
    await expect(
      signaturePlacementRepository.replaceForDocument(
        esicDocumentId,
        employeeId,
        [{ ...BOX, signerRole: SIGNER_ROLES.PHOTO, signerUserId: hrUserId }],
        hrUserId,
      ),
    ).rejects.toMatchObject({ number: 547 })
  })

  it('still refuses an authoriser box with no signer, and an employee box with one', async () => {
    await expect(
      signaturePlacementRepository.replaceForDocument(
        esicDocumentId,
        employeeId,
        [{ ...BOX, signerRole: SIGNER_ROLES.AUTHORISER, signerUserId: null }],
        hrUserId,
      ),
    ).rejects.toMatchObject({ number: 547 })

    await expect(
      signaturePlacementRepository.replaceForDocument(
        esicDocumentId,
        employeeId,
        [{ ...BOX, signerRole: SIGNER_ROLES.EMPLOYEE, signerUserId: hrUserId }],
        hrUserId,
      ),
    ).rejects.toMatchObject({ number: 547 })
  })

  it('leaves the previous set in place when the new one is refused', async () => {
    // XACT_ABORT ON: the DELETE and the INSERT are one transaction, so a set
    // the database refuses cannot leave the document with no placements.
    await signaturePlacementRepository.replaceForDocument(
      esicDocumentId,
      employeeId,
      [{ ...BOX, signerRole: SIGNER_ROLES.PHOTO, signerUserId: null }],
      hrUserId,
    )

    await expect(
      signaturePlacementRepository.replaceForDocument(
        esicDocumentId,
        employeeId,
        [{ ...BOX, signerRole: SIGNER_ROLES.PHOTO, signerUserId: hrUserId }],
        hrUserId,
      ),
    ).rejects.toMatchObject({ number: 547 })

    const rows = await signaturePlacementRepository.listForDocument(esicDocumentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.signerUserId).toBeNull()
  })
})
