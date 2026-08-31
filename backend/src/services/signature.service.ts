import { PDFDocument } from 'pdf-lib'
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  SIGNATURE_STATUS,
  canTransitionSignature,
  normalizeRotation,
  type AuthUser,
  type EmployeeDocument,
  type SavePlacementsInput,
  type SignaturePlacement,
  type SignatureStatus,
} from '@asps-dms/shared'
import * as employeeDocumentRepository from '../repositories/employeeDocument.repository.js'
import * as employeeSignatureRepository from '../repositories/employeeSignature.repository.js'
import * as signaturePlacementRepository from '../repositories/signaturePlacement.repository.js'
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors.js'
import * as audit from './audit.service.js'
import type { RequestContext } from './auth.service.js'
import * as documentService from './document.service.js'
import * as employeeService from './employee.service.js'
import { inspectSignatureUpload, type UploadedFile } from './fileValidation.service.js'
import { stampSignature } from './signatureStamp.service.js'
import * as storage from './storage.service.js'

/**
 * Employee signatures, their placements, and the signed output.
 *
 * The specification's hard rule runs through all of it: nothing here applies a
 * signature without an explicit instruction from HR (standing assumption 8).
 * Detection, when it arrives, produces candidates; only savePlacements draws
 * anything, and only because someone asked it to.
 */

export interface EmployeeSignatureSummary {
  employeeId: number
  hasSignature: boolean
  mimeType: string | null
  widthPx: number | null
  heightPx: number | null
  uploadedAt: string | null
}

export async function getSignatureSummary(employeeId: number): Promise<EmployeeSignatureSummary> {
  const record = await employeeSignatureRepository.findActiveByEmployee(employeeId)
  return {
    employeeId,
    hasSignature: record !== null,
    mimeType: record?.mimeType ?? null,
    widthPx: record?.widthPx ?? null,
    heightPx: record?.heightPx ?? null,
    uploadedAt: record?.uploadedAt ?? null,
  }
}

/**
 * Measures the image by embedding it exactly as the stamper will.
 *
 * This is not only about recording the pixel size: pdf-lib cannot embed a
 * progressive JPEG, and finding that out here - while someone is looking at an
 * upload form - is far better than finding it out later, when they are trying
 * to sign a document and the failure appears to be about the document.
 */
async function measureSignature(
  buffer: Buffer,
  mimeType: string,
): Promise<{ widthPx: number; heightPx: number }> {
  const probe = await PDFDocument.create()
  const image = mimeType === 'image/png' ? await probe.embedPng(buffer) : await probe.embedJpg(buffer)
  return { widthPx: image.width, heightPx: image.height }
}

/**
 * Uploads or replaces an employee's signature.
 *
 * One per employee, reused on every document they sign (Section 24). Replacing
 * it does NOT re-stamp documents that were already signed: those were signed
 * with the image that was current at the time, and silently changing a signature
 * on a document that has already been issued is not something this system
 * should do on its own.
 */
export async function uploadSignature(
  employeeId: number,
  file: UploadedFile,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeSignatureSummary> {
  // 404s here rather than failing on the foreign key three statements later.
  await employeeService.getById(employeeId)
  const existing = await employeeSignatureRepository.findActiveByEmployee(employeeId)

  const inspected = await inspectSignatureUpload(file)
  const measured = await measureSignature(file.buffer, inspected.mimeType)
  const stored = await storage.storeSignature(employeeId, file.buffer, inspected.extension)

  try {
    await employeeSignatureRepository.replaceActive({
      employeeId,
      storedFileName: stored.storedFileName,
      relativePath: stored.relativePath,
      originalFileName: inspected.safeOriginalName,
      mimeType: inspected.mimeType,
      fileSizeBytes: stored.sizeBytes,
      widthPx: measured.widthPx,
      heightPx: measured.heightPx,
      uploadedBy: actor.userId,
    })
  } catch (error) {
    await storage.discardStoredFile(stored.relativePath)
    throw error
  }

  await audit.record({
    userId: actor.userId,
    action: existing ? AUDIT_ACTIONS.SIGNATURE_REPLACED : AUDIT_ACTIONS.SIGNATURE_UPLOADED,
    entityType: AUDIT_ENTITY_TYPES.SIGNATURE,
    entityId: employeeId,
    ipAddress: context.ipAddress,
    metadata: {
      mimeType: inspected.mimeType,
      sizeBytes: stored.sizeBytes,
      widthPx: measured.widthPx,
      heightPx: measured.heightPx,
    },
  })

  return getSignatureSummary(employeeId)
}

/** Streams the signature image, for the editor and the employee page. */
export async function openSignature(
  employeeId: number,
): Promise<{ stream: NodeJS.ReadableStream; mimeType: string }> {
  const record = await employeeSignatureRepository.findActiveByEmployee(employeeId)
  if (!record) throw new NotFoundError('This employee has no signature on file yet.')

  if (!(await storage.storedFileExists(record.relativePath))) {
    throw new ConflictError(
      'The signature is recorded but its image is missing from the document store. ' +
        'Tell your administrator.',
    )
  }

  return { stream: storage.openStoredFile(record.relativePath), mimeType: record.mimeType }
}

export async function listPlacements(documentId: number): Promise<SignaturePlacement[]> {
  await documentService.getById(documentId)
  return signaturePlacementRepository.listForDocument(documentId)
}

/**
 * Saves the complete set of placements and regenerates the signed document.
 *
 * The output is built from the ORIGINAL every time (Sections 34 and 64).
 * Stamping the previous output instead would compound every placement that was
 * ever made, and a corrected placement would leave the wrong one visible
 * underneath the right one.
 *
 * An empty set removes the signature: the processed file is dropped and the
 * document goes back to needing review, which is how a mistaken placement is
 * undone.
 */
export async function savePlacements(
  documentId: number,
  input: SavePlacementsInput,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeDocument> {
  const document = await documentService.getById(documentId)

  if (document.originalFileName === null) {
    throw new ConflictError('There is no file on this document to place a signature on.')
  }

  if (input.placements.length === 0) {
    return removePlacements(document, actor, context)
  }

  const pageCount = new Set(input.placements.map((placement) => placement.pageNumber)).size

  const signature = await employeeSignatureRepository.findActiveByEmployee(document.employeeId)
  if (!signature) {
    throw new ConflictError(
      `${document.employeeName} has no signature on file. Upload one before signing a document.`,
    )
  }

  const location = await employeeDocumentRepository.findStoredFile(documentId)
  if (!location?.originalFilePath) {
    throw new ConflictError('This document has no stored file to sign.')
  }

  const [source, signatureImage] = await Promise.all([
    storage.readStoredFile(location.originalFilePath),
    storage.readStoredFile(signature.relativePath),
  ])

  const stamped = await stampSignature({
    source,
    sourceMimeType: location.mimeType ?? 'application/pdf',
    signature: signatureImage,
    signatureMimeType: signature.mimeType,
    placements: input.placements.map((placement) => ({
      pageNumber: placement.pageNumber,
      rect: {
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height,
      },
      pageRotation: normalizeRotation(placement.pageRotation),
    })),
  })

  // Q8: the signed output is always a PDF, whatever the original was, so there
  // is one format to preview, download and print.
  const stored = await storage.storeProcessedDocument(document.employeeId, stamped, '.pdf')

  try {
    await signaturePlacementRepository.replaceForDocument(
      documentId,
      document.employeeId,
      input.placements.map((placement) => ({
        pageNumber: placement.pageNumber,
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height,
        pageRotation: placement.pageRotation,
        method: placement.method,
        detectionMethod: placement.detectionMethod,
        confidence: placement.confidence,
      })),
      actor.userId,
    )
    await employeeDocumentRepository.setProcessedFile(
      documentId,
      stored.relativePath,
      SIGNATURE_STATUS.ADDED,
    )
    await signaturePlacementRepository.markApplied(documentId)
  } catch (error) {
    await storage.discardStoredFile(stored.relativePath)
    throw error
  }

  await audit.record({
    userId: actor.userId,
    // Three different things a person can have done, and the audit trail should
    // be able to tell them apart: placed it themselves, accepted what detection
    // proposed, or moved what detection proposed before accepting it.
    action: placementAction(input),
    entityType: AUDIT_ENTITY_TYPES.SIGNATURE_PLACEMENT,
    entityId: documentId,
    ipAddress: context.ipAddress,
    metadata: {
      employeeCode: document.employeeCode,
      documentName: document.documentName,
      placements: input.placements.length,
      pages: pageCount,
      // The positions themselves, so the audit trail can answer where a
      // signature was put, not merely that one was.
      rects: input.placements.map((placement) => ({
        page: placement.pageNumber,
        x: round(placement.x),
        y: round(placement.y),
        width: round(placement.width),
        height: round(placement.height),
        method: placement.method,
      })),
    },
  })

  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.PROCESSED_PDF_GENERATED,
    entityType: AUDIT_ENTITY_TYPES.DOCUMENT,
    entityId: documentId,
    ipAddress: context.ipAddress,
    metadata: { sizeBytes: stored.sizeBytes, sha256: stored.sha256.toString('hex') },
  })

  return documentService.getById(documentId)
}

function placementAction(input: SavePlacementsInput) {
  if (input.placements.every((placement) => placement.method === 'Manual')) {
    return AUDIT_ACTIONS.SIGNATURE_PLACED_MANUALLY
  }
  return input.placements.some((placement) => placement.method === 'Adjusted')
    ? AUDIT_ACTIONS.SIGNATURE_ADJUSTED
    : AUDIT_ACTIONS.SIGNATURE_ACCEPTED
}

/** Four decimal places is under a tenth of a millimetre on an A4 page. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

async function removePlacements(
  document: EmployeeDocument,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeDocument> {
  await signaturePlacementRepository.replaceForDocument(
    document.documentId,
    document.employeeId,
    [],
    actor.userId,
  )

  // The processed file is dropped rather than kept: it shows a signature that
  // is no longer placed, and it is served in preference to the original.
  const location = await employeeDocumentRepository.findStoredFile(document.documentId)
  const nextStatus: SignatureStatus = document.requiresSignature
    ? SIGNATURE_STATUS.REVIEW_REQUIRED
    : SIGNATURE_STATUS.NOT_REQUIRED

  await employeeDocumentRepository.setProcessedFile(document.documentId, null, nextStatus)

  if (location?.processedFilePath) {
    await storage.discardStoredFile(location.processedFilePath)
  }

  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.SIGNATURE_REMOVED,
    entityType: AUDIT_ENTITY_TYPES.SIGNATURE_PLACEMENT,
    entityId: document.documentId,
    ipAddress: context.ipAddress,
    metadata: { employeeCode: document.employeeCode, documentName: document.documentName },
  })

  return documentService.getById(document.documentId)
}

/**
 * Marks a document as deliberately not signed.
 *
 * A real outcome, not a failure: plenty of documents need no signature at all,
 * and 'Skipped' says a person decided that, where leaving it in ReviewRequired
 * for ever says only that nobody got to it.
 */
export async function skipSignature(
  documentId: number,
  reason: string | undefined,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeDocument> {
  const document = await documentService.getById(documentId)

  if (!canTransitionSignature(document.signatureStatus, SIGNATURE_STATUS.SKIPPED)) {
    throw new BadRequestError(
      `A document whose signature is '${document.signatureStatus}' cannot be skipped.`,
    )
  }

  const changed = await employeeDocumentRepository.setSignatureStatus(
    documentId,
    document.signatureStatus,
    SIGNATURE_STATUS.SKIPPED,
  )
  if (!changed) {
    throw new ConflictError(
      'Someone else changed this document a moment ago. Reload it and try again.',
    )
  }

  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.SIGNATURE_SKIPPED,
    entityType: AUDIT_ENTITY_TYPES.DOCUMENT,
    entityId: documentId,
    ipAddress: context.ipAddress,
    metadata: {
      employeeCode: document.employeeCode,
      documentName: document.documentName,
      previousStatus: document.signatureStatus,
      reason,
    },
  })

  return documentService.getById(documentId)
}
