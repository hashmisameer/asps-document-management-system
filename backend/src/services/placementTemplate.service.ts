import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  IDENTITY_CARD_DOCUMENT_CODES,
  PHOTO_DOCUMENT_CODE,
  SIGNER_ROLES,
  type AuthUser,
  toVariant,
  variantLabel,
  type DocumentTypePlacement,
  type DocumentTypeTemplateSummary,
  type SaveTemplateInput,
  type TemplateVariant,
} from '@asps-dms/shared'
import * as documentTypePlacementRepository from '../repositories/documentTypePlacement.repository.js'
import * as documentTypeRepository from '../repositories/documentType.repository.js'
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.js'
import * as audit from './audit.service.js'
import type { RequestContext } from './auth.service.js'

/**
 * Placement templates: where the boxes go on every document of a type.
 *
 * Set once by an administrator, on one real document of the type as the
 * sample, and recorded against the TYPE - per VARIANT, because one checklist
 * entry can be two pieces of paper: the sample's page count and first-page
 * size say which. Nothing here touches a document, its own placements, or a
 * stored file: saving a template stamps nothing, and there is no action that
 * applies one to the documents already there. The next change stamps NEW
 * uploads from it, and only where an upload matches a variant exactly.
 */

export async function list(): Promise<DocumentTypeTemplateSummary[]> {
  return documentTypePlacementRepository.summaries()
}

export async function getForType(documentTypeId: number): Promise<DocumentTypePlacement[]> {
  const type = await documentTypeRepository.findById(documentTypeId)
  if (!type) throw new NotFoundError('That document type does not exist.')
  return documentTypePlacementRepository.listForType(documentTypeId)
}

const SCANNED = new Set<string>(IDENTITY_CARD_DOCUMENT_CODES)

export interface SavedTemplate {
  placements: DocumentTypePlacement[]
  /** The variant this save wrote. */
  variant: TemplateVariant
  /** True when a template for this variant existed and has been replaced. */
  replacedExisting: boolean
}

/**
 * Replaces ONE VARIANT of a type's template with the set given.
 *
 * Refused, with the reason, when: the type does not exist or is retired; the
 * type is a scanned identity card, which has no fixed layout; a photograph box
 * is on any type but the ESIC form - the same rule and the same words the
 * stamper uses, said now rather than at the first upload; the boxes were
 * drawn on pages of different sizes or rotations, which cannot all be one
 * sample; or a box on the first page does not match the variant the save
 * says it is for.
 *
 * Says whether it replaced an existing variant, so a collision - two forms
 * with the same page count and size - is visible rather than silent.
 */
export async function save(
  documentTypeId: number,
  input: SaveTemplateInput,
  actor: AuthUser,
  context: RequestContext,
): Promise<SavedTemplate> {
  const type = await documentTypeRepository.findById(documentTypeId)
  if (!type) throw new NotFoundError('That document type does not exist.')
  if (!type.isActive) {
    throw new ConflictError(`${type.documentName} has been retired and cannot have a template.`)
  }
  if (SCANNED.has(type.documentCode)) {
    throw new ConflictError(
      `${type.documentName} is a scanned card with no fixed layout, so it has no template.`,
    )
  }

  const hasPhoto = input.placements.some((box) => box.signerRole === SIGNER_ROLES.PHOTO)
  if (hasPhoto && type.documentCode !== PHOTO_DOCUMENT_CODE) {
    throw new ConflictError(
      `A photograph can be placed on the ESIC form only, not on ${type.documentName}.`,
    )
  }

  const variant = toVariant(input.samplePageCount, input.sampleWidthPt, input.sampleHeightPt)

  // One sample, one page size per page number, one rotation: a set drawn on
  // two different documents would describe neither. And the first page must
  // be the variant's page, or the key names a form the boxes are not on.
  const seen = new Map<number, { w: number; h: number; rotation: number }>()
  for (const box of input.placements) {
    const key = box.pageNumber
    const prior = seen.get(key)
    if (!prior) {
      seen.set(key, { w: box.pageWidthPt, h: box.pageHeightPt, rotation: box.pageRotation })
    } else if (
      Math.abs(prior.w - box.pageWidthPt) > 0.5 ||
      Math.abs(prior.h - box.pageHeightPt) > 0.5 ||
      prior.rotation !== box.pageRotation
    ) {
      throw new ValidationError(
        [{ path: 'placements', message: `The boxes on page ${key} were drawn on different pages.` }],
        'The boxes were not all drawn on the same sample document.',
      )
    }
    if (
      key === 1 &&
      (Math.round(box.pageWidthPt) !== variant.widthPt ||
        Math.round(box.pageHeightPt) !== variant.heightPt)
    ) {
      throw new ValidationError(
        [{ path: 'placements', message: 'A box on page 1 is not on the page the variant names.' }],
        'The boxes were not drawn on the form this save is for.',
      )
    }
  }

  const replacedExisting = await documentTypePlacementRepository.variantExists(
    documentTypeId,
    variant,
  )

  await documentTypePlacementRepository.replaceForVariant(
    documentTypeId,
    variant,
    input.placements.map((box) => ({
      signerRole: box.signerRole,
      pageNumber: box.pageNumber,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      pageRotation: box.pageRotation,
      pageWidthPt: box.pageWidthPt,
      pageHeightPt: box.pageHeightPt,
    })),
    input.sampleDocumentId,
    actor.userId,
  )

  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.TEMPLATE_SAVED,
    entityType: AUDIT_ENTITY_TYPES.DOCUMENT_TYPE,
    entityId: documentTypeId,
    ipAddress: context.ipAddress,
    metadata: {
      documentCode: type.documentCode,
      documentName: type.documentName,
      // The variant, in words and in numbers: which of the two PF papers this
      // was is what somebody reading the trail needs to know.
      variant: variantLabel(variant),
      pageCount: variant.pageCount,
      widthPt: variant.widthPt,
      heightPt: variant.heightPt,
      replacedExisting,
      removed: input.placements.length === 0,
      boxes: input.placements.length,
      roles: input.placements.map((box) => box.signerRole),
      sampleDocumentId: input.sampleDocumentId,
    },
  })

  return {
    placements: await documentTypePlacementRepository.listForType(documentTypeId),
    variant,
    replacedExisting,
  }
}
