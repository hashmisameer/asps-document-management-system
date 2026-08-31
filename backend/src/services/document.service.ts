import {
  API_ERROR_CODES,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  DOCUMENT_STATUS,
  DOCUMENT_STATUS_LABEL,
  PERMISSIONS,
  SIGNATURE_STATUS,
  canTransitionDocument,
  deriveDeadline,
  roleHasPermission,
  type AuthUser,
  type DocumentStatus,
  type EmployeeDocument,
  type SignatureStatus,
  type UpdateDocumentDeadlineInput,
  type UploadDocumentInput,
} from '@asps-dms/shared'
import * as employeeDocumentRepository from '../repositories/employeeDocument.repository.js'
import type { EmployeeDocumentRecord } from '../repositories/employeeDocument.repository.js'
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/errors.js'
import * as audit from './audit.service.js'
import type { RequestContext } from './auth.service.js'
import { inspectDocumentUpload, type UploadedFile } from './fileValidation.service.js'
import * as storage from './storage.service.js'

/**
 * Employee documents: the file, its status, and its deadline.
 *
 * Every status change goes through canTransitionDocument rather than being
 * written directly, so the state machine in shared/src/constants/documents.ts
 * is the whole truth about what is allowed. A change it does not permit is a
 * 409 with INVALID_STATE_TRANSITION, never a silent write.
 */

/** Adds the deadline fields, which are derived and never stored. */
export function withDeadline(record: EmployeeDocumentRecord): EmployeeDocument {
  const deadline = deriveDeadline(record.dueDate, record.status)
  return { ...record, deadlineState: deadline.state, daysRemaining: deadline.daysRemaining }
}

async function loadRecord(documentId: number): Promise<EmployeeDocumentRecord> {
  const record = await employeeDocumentRepository.findById(documentId)
  if (!record) throw new NotFoundError('That document does not exist.')
  return record
}

export async function getById(documentId: number): Promise<EmployeeDocument> {
  return withDeadline(await loadRecord(documentId))
}

function invalidTransition(from: DocumentStatus, to: DocumentStatus): ConflictError {
  return new ConflictError(
    `A ${DOCUMENT_STATUS_LABEL[from]} document cannot be marked ${DOCUMENT_STATUS_LABEL[to]}.`,
    API_ERROR_CODES.INVALID_STATE_TRANSITION,
  )
}

/**
 * Someone else changed the document between the read and the write.
 *
 * The status is part of the UPDATE's WHERE clause, so this is what a lost
 * update looks like from here - and reporting it is the entire point of
 * checking, because the alternative is silently overwriting the other person's
 * decision.
 */
function concurrentChange(): ConflictError {
  return new ConflictError(
    'Someone else changed this document a moment ago. Reload it and try again.',
  )
}

/**
 * Stores an uploaded file against a checklist row.
 *
 * The order is deliberate: validate, write the file, then update the row. If
 * the row update fails the file is removed again, because an orphaned file on
 * disk is recoverable housekeeping while a row pointing at a file that was
 * never written is a document that cannot be opened.
 */
export async function uploadFile(
  documentId: number,
  file: UploadedFile,
  input: UploadDocumentInput,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeDocument> {
  const record = await loadRecord(documentId)
  const isReplacement = record.originalFileName !== null

  // Uploading for the first time and replacing what is already there are
  // separate permissions, and only the row itself knows which this is.
  if (isReplacement && !roleHasPermission(actor.role, PERMISSIONS.DOCUMENT_REPLACE)) {
    throw new ForbiddenError('You do not have permission to replace a document that is already in.')
  }

  const targetStatus: DocumentStatus = input.landingStatus
  if (!canTransitionDocument(record.status, targetStatus)) {
    throw invalidTransition(record.status, targetStatus)
  }

  const inspected = await inspectDocumentUpload(file)
  const stored = await storage.storeDocument(record.employeeId, file.buffer, inspected.extension)

  // A replacement voids whatever signature work was done on the previous file:
  // a placement describes a page in a document that is no longer served.
  const signatureStatus: SignatureStatus = record.requiresSignature
    ? SIGNATURE_STATUS.PENDING_DETECTION
    : SIGNATURE_STATUS.NOT_REQUIRED

  try {
    await employeeDocumentRepository.attachFile({
      documentId,
      originalFileName: inspected.safeOriginalName,
      storedFileName: stored.storedFileName,
      originalFilePath: stored.relativePath,
      fileSizeBytes: stored.sizeBytes,
      mimeType: inspected.mimeType,
      sha256: stored.sha256,
      status: targetStatus,
      signatureStatus,
      uploadedBy: actor.userId,
      verifiedBy: targetStatus === DOCUMENT_STATUS.VERIFIED ? actor.userId : null,
      dueDate: record.dueDate,
      // Section 19: a document HR already holds on paper for an existing
      // employee is not being awaited from anyone, so it carries no deadline.
      clearDueDate: input.isExistingRecord,
    })
  } catch (error) {
    await storage.discardStoredFile(stored.relativePath)
    throw error
  }

  await audit.record({
    userId: actor.userId,
    action: isReplacement ? AUDIT_ACTIONS.DOCUMENT_REPLACED : AUDIT_ACTIONS.DOCUMENT_UPLOADED,
    entityType: AUDIT_ENTITY_TYPES.DOCUMENT,
    entityId: documentId,
    ipAddress: context.ipAddress,
    metadata: {
      employeeCode: record.employeeCode,
      documentName: record.documentName,
      fileName: inspected.safeOriginalName,
      mimeType: inspected.mimeType,
      sizeBytes: stored.sizeBytes,
      // The digest identifies the exact bytes that were accepted, which is what
      // makes "this is the file that was uploaded" checkable later.
      sha256: stored.sha256.toString('hex'),
      status: targetStatus,
      replacedPreviousFile: isReplacement,
      notes: input.notes,
    },
  })

  return getById(documentId)
}

export async function verify(
  documentId: number,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeDocument> {
  const record = await loadRecord(documentId)

  if (!canTransitionDocument(record.status, DOCUMENT_STATUS.VERIFIED)) {
    throw invalidTransition(record.status, DOCUMENT_STATUS.VERIFIED)
  }
  if (record.originalFileName === null) {
    throw new ConflictError('There is no file to verify on this document yet.')
  }

  const changed = await employeeDocumentRepository.setStatus(
    documentId,
    record.status,
    DOCUMENT_STATUS.VERIFIED,
    actor.userId,
    null,
  )
  if (!changed) throw concurrentChange()

  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.DOCUMENT_VERIFIED,
    entityType: AUDIT_ENTITY_TYPES.DOCUMENT,
    entityId: documentId,
    ipAddress: context.ipAddress,
    metadata: {
      employeeCode: record.employeeCode,
      documentName: record.documentName,
      previousStatus: record.status,
    },
  })

  return getById(documentId)
}

export async function reject(
  documentId: number,
  reason: string,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeDocument> {
  const record = await loadRecord(documentId)

  if (!canTransitionDocument(record.status, DOCUMENT_STATUS.REJECTED)) {
    throw invalidTransition(record.status, DOCUMENT_STATUS.REJECTED)
  }

  const changed = await employeeDocumentRepository.setStatus(
    documentId,
    record.status,
    DOCUMENT_STATUS.REJECTED,
    actor.userId,
    reason,
  )
  if (!changed) throw concurrentChange()

  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.DOCUMENT_REJECTED,
    entityType: AUDIT_ENTITY_TYPES.DOCUMENT,
    entityId: documentId,
    ipAddress: context.ipAddress,
    // The reason is stored on the row for the person who has to fix it, and
    // here for the record of who decided it and when.
    metadata: {
      employeeCode: record.employeeCode,
      documentName: record.documentName,
      previousStatus: record.status,
      reason,
    },
  })

  return getById(documentId)
}

/**
 * Overrides one document's deadline.
 *
 * The deadline computed from the document type is a default, not a rule: HR can
 * extend it for one employee without changing what every future joiner gets.
 */
export async function updateDeadline(
  documentId: number,
  input: UpdateDocumentDeadlineInput,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeDocument> {
  const record = await loadRecord(documentId)

  if (record.dueDate !== input.dueDate) {
    await employeeDocumentRepository.setDueDate(documentId, input.dueDate)

    await audit.record({
      userId: actor.userId,
      action: AUDIT_ACTIONS.DEADLINE_CHANGED,
      entityType: AUDIT_ENTITY_TYPES.DOCUMENT,
      entityId: documentId,
      ipAddress: context.ipAddress,
      metadata: {
        employeeCode: record.employeeCode,
        documentName: record.documentName,
        from: record.dueDate,
        to: input.dueDate,
        reason: input.reason,
      },
    })
  }

  return getById(documentId)
}

export interface DocumentDelivery {
  stream: NodeJS.ReadableStream
  mimeType: string
  /** Built from the employee code and document name, not from the upload. */
  fileName: string
}

/**
 * Opens a document's file for the browser.
 *
 * The PROCESSED file is served when there is one, so a signed document shows
 * its signature; the original is what is there until then. Nothing about the
 * path on disk crosses this boundary - the caller gets a stream.
 */
export async function openForDelivery(
  documentId: number,
  intent: 'preview' | 'download',
  actor: AuthUser,
  context: RequestContext,
): Promise<DocumentDelivery> {
  const location = await employeeDocumentRepository.findStoredFile(documentId)
  if (!location) throw new NotFoundError('That document does not exist.')

  const servingProcessed = location.processedFilePath !== null
  const relativePath = location.processedFilePath ?? location.originalFilePath
  if (!relativePath) {
    throw new NotFoundError('No file has been uploaded for this document yet.')
  }

  // The processed copy is always a PDF, even when the original was a scan
  // (open question Q8), so it must not be served with the original's type - a
  // PDF labelled image/jpeg is a file the browser refuses to display.
  const mimeType = servingProcessed
    ? 'application/pdf'
    : (location.mimeType ?? 'application/octet-stream')

  if (!(await storage.storedFileExists(relativePath))) {
    // The row says there is a file and the store disagrees. That is an
    // operational problem - a restore that missed the volume, most likely - and
    // it must be findable in the log rather than reported as "not found".
    throw new ConflictError(
      'This document is recorded but its file is missing from the document store. ' +
        'Tell your administrator.',
    )
  }

  await audit.record({
    userId: actor.userId,
    action: intent === 'download' ? AUDIT_ACTIONS.DOCUMENT_DOWNLOADED : AUDIT_ACTIONS.DOCUMENT_VIEWED,
    entityType: AUDIT_ENTITY_TYPES.DOCUMENT,
    entityId: documentId,
    ipAddress: context.ipAddress,
    metadata: {
      employeeCode: location.employeeCode,
      documentName: location.documentName,
      servedProcessedFile: location.processedFilePath !== null,
    },
  })

  return {
    stream: storage.openStoredFile(relativePath),
    mimeType,
    fileName: deliveryFileName(location.employeeCode, location.documentName, relativePath),
  }
}

/**
 * A predictable file name for whoever saves it.
 *
 * The uploaded name is not reused: it is chosen by whoever uploaded it and may
 * be anything at all, while 'EMP001 - PAN Card.pdf' files itself.
 */
function deliveryFileName(
  employeeCode: string,
  documentName: string,
  relativePath: string,
): string {
  const extension = relativePath.slice(relativePath.lastIndexOf('.'))
  const cleanName = documentName.replace(/[^\w\s.-]/g, '').trim()
  return `${employeeCode} - ${cleanName}${extension}`
}
