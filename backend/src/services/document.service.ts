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
  type DeadlineState,
  type DocumentListQuery,
  type DocumentStatus,
  type EmployeeDocument,
  type Paginated,
  type FieldCheck,
  type SignatureStatus,
  type UpdateDocumentDeadlineInput,
  type UploadDocumentInput,
} from '@asps-dms/shared'
import * as documentTypeRepository from '../repositories/documentType.repository.js'
import * as employeeRepository from '../repositories/employee.repository.js'
import * as employeeDocumentRepository from '../repositories/employeeDocument.repository.js'
import * as signaturePlacementRepository from '../repositories/signaturePlacement.repository.js'
import type {
  AttachIdentityCheck,
  DocumentListRecord,
  EmployeeDocumentRecord,
} from '../repositories/employeeDocument.repository.js'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/errors.js'
import * as audit from './audit.service.js'
import type { RequestContext } from './auth.service.js'
import { inspectDocumentUpload, type UploadedFile } from './fileValidation.service.js'
import * as storage from './storage.service.js'
import { checkUpload, describeFailure } from './documentVerification.service.js'

/**
 * Employee documents: the file, its status, and its deadline.
 *
 * Every status change goes through canTransitionDocument rather than being
 * written directly, so the state machine in shared/src/constants/documents.ts
 * is the whole truth about what is allowed. A change it does not permit is a
 * 409 with INVALID_STATE_TRANSITION, never a silent write.
 */

/**
 * Adds the deadline fields, which are derived and never stored.
 *
 * `employeeHasLeft` stops the clock. Nothing about the document changes - a
 * missing form is still missing - but it is no longer counted as late, because
 * there is nobody left to be late.
 */
export function withDeadline(
  record: EmployeeDocumentRecord,
  options: { employeeHasLeft?: boolean } = {},
): EmployeeDocument {
  // The record carries the fact, so a document read on its own is as right as
  // one read from a checklist. The option still wins where a caller already
  // knows - it is reading the same employee either way.
  const { employeeHasLeft, ...document } = record
  const deadline = deriveDeadline(record.dueDate, record.status, {
    employeeHasLeft: options.employeeHasLeft ?? employeeHasLeft,
  })
  return { ...document, deadlineState: deadline.state, daysRemaining: deadline.daysRemaining }
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
 * The identity check, and where its result lives.
 *
 * Every outcome is recorded on the ROW rather than only in the log, because
 * "this service card was accepted although the name could not be read" has to
 * be visible on the document months later, not reconstructed by someone who
 * knew to go looking in the audit trail -
 *
 *   Checking    the file is stored and the reading has not finished
 *   Passed      the details the type asks for were found in the document
 *   Failed      they were not, and somebody needs to look at it
 *   NotChecked  the type asks for nothing, or the check is switched off
 *   Overridden  it failed and a person accepted it anyway, in their own name
 */
/**
 * Takes a refused document back off the row and off the disk.
 *
 * The row is put back first and the file discarded second: a row pointing at a
 * file that has been deleted is a document that cannot be opened, while a file
 * on disk that no row points at is housekeeping.
 */
async function removeRefusedFile(
  documentId: number,
  storedFileName: string,
  relativePath: string,
  reason: string,
): Promise<void> {
  const cleared = await employeeDocumentRepository.clearRefusedFile(
    documentId,
    storedFileName,
    reason,
  )
  if (!cleared) return

  await storage.discardStoredFile(relativePath)
  logger.info({ documentId }, 'A refused identity document was not kept')
}

/**
 * Whether this document type is checked at all.
 *
 * Answered from the type alone, with no reading, so the upload can decide in
 * milliseconds whether to say 'Checking' or 'NotChecked' before it replies.
 */
async function isCheckedType(documentTypeId: number): Promise<boolean> {
  if (!env.IDENTITY_CHECK_ENABLED) return false
  const documentType = await documentTypeRepository.findById(documentTypeId)
  if (!documentType) return false
  return documentType.requiredFields.length > 0 || documentType.recognitionKeywords.length > 0
}

/**
 * Reads a stored document and records what the check found.
 *
 * Runs AFTER the upload has been answered, so nothing here is allowed to fail
 * the upload - it has already succeeded, and the file is already on disk. Every
 * outcome, including this throwing, ends with the row saying something other
 * than 'Checking'; a row stuck on 'Checking' is a spinner nobody can clear.
 */
export async function completeIdentityCheck(
  documentId: number,
  storedFileName: string,
  actor: AuthUser,
  context: RequestContext,
): Promise<void> {
  try {
    const record = await employeeDocumentRepository.findById(documentId)
    const location = await employeeDocumentRepository.findStoredFile(documentId)
    if (!record || !location?.originalFilePath) return

    const documentType = await documentTypeRepository.findById(record.documentTypeId)
    const employee = await employeeRepository.findById(record.employeeId)
    if (!documentType || !employee) return

    const buffer = await storage.readStoredFile(location.originalFilePath)
    const result = await checkUpload(
      employee,
      documentType.requiredFields,
      { buffer, mimeType: location.mimeType ?? 'application/octet-stream' },
      documentType.recognitionKeywords,
      documentType.documentName,
    )

    if (result === null) {
      await employeeDocumentRepository.recordIdentityCheck({
        documentId,
        storedFileName,
        status: 'NotChecked',
        source: null,
        checks: [],
        reason: null,
        overrideBy: null,
      })
      return
    }

    const failureReason = result.passed
      ? null
      : describeFailure(result, documentType.documentName)

    await employeeDocumentRepository.recordIdentityCheck({
      documentId,
      storedFileName,
      status: result.passed ? 'Passed' : 'Failed',
      source: result.source,
      checks: result.checks,
      // On a failure this is the sentence HR reads. It is stored rather than
      // rebuilt later so the wording cannot drift from what was actually found.
      reason: failureReason,
      overrideBy: null,
    })

    // An identity card whose name is not the employee's is not kept.
    //
    // For these types the office's rule is 'if it matches, upload it; if not,
    // do not' - and since the reading happens after the file is stored, not
    // uploading it means taking it back off. The row goes to Pending and the
    // file is discarded, so the result is as if the upload had not happened.
    //
    // The reason survives on the row, because 'nothing happened' with no
    // explanation is the most confusing outcome available. And an upload sent
    // WITH a reason is never removed - see uploadFile - so a card this system
    // cannot read is still attachable by somebody holding it.
    if (!result.passed && documentType.refuseOnCheckFailure) {
      await removeRefusedFile(
        documentId,
        storedFileName,
        location.originalFilePath,
        failureReason ?? 'This document did not match the employee.',
      )
    }

    if (!result.passed) {
      await audit.record({
        userId: actor.userId,
        action: AUDIT_ACTIONS.DOCUMENT_IDENTITY_REFUSED,
        entityType: AUDIT_ENTITY_TYPES.DOCUMENT,
        entityId: documentId,
        ipAddress: context.ipAddress,
        metadata: {
          employeeCode: record.employeeCode,
          documentName: record.documentName,
          source: result.source,
          unreadable: result.unreadable,
          ...summariseChecks(result.checks),
        },
      })
    }
  } catch (error) {
    // The upload succeeded and the file is safe. All that is lost is the
    // reading, so the row is moved off 'Checking' and says so plainly.
    logger.error({ err: error, documentId }, 'The identity check could not be completed')
    try {
      await employeeDocumentRepository.recordIdentityCheck({
        documentId,
        storedFileName,
        status: 'Failed',
        source: null,
        checks: [],
        reason:
          'This document could not be read - the check itself failed rather than the document. ' +
          'Accept it with a reason, or replace it to try again.',
        overrideBy: null,
      })
    } catch (secondary) {
      logger.error({ err: secondary, documentId }, 'Could not record the failed identity check')
    }
  }
}

/**
 * The check outcomes as audit metadata: which fields, and how each came out.
 *
 * The expected VALUES are dropped here. The audit trail is read by more people
 * and kept for longer than the employee record itself, and a copy of an Aadhaar
 * number in it would outlive every control on the record it came from.
 */
function summariseChecks(checks: readonly FieldCheck[]): { fieldResults: string[] } {
  return { fieldResults: checks.map((check) => `${check.field}=${check.result}`) }
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

  // The file is stored FIRST and read afterwards.
  //
  // Reading takes between four and sixty seconds, and it used to happen here,
  // before anything was written - so whoever pressed Upload watched a spinner
  // for the whole of it and learned to assume the system had hung. One measured
  // request sat open for 62 seconds.
  //
  // The cost of the change is real and worth stating: a document that is going
  // to be refused now reaches the disk, where before it never did. It is stored
  // saying 'Checking', and the row says what the reading found when it finishes.
  // A refusal is a question for a person rather than a rejected upload, which is
  // what it always was in practice - the answer was never 'throw the file away',
  // it was 'somebody look at this'.
  // An upload sent WITH a reason is a person saying they have looked at the
  // document and it is the right one. That is accepted as given and not read at
  // all: the reading exists to raise the question, and the question has already
  // been answered by somebody whose name goes on the answer.
  //
  // This is also the only way an identity card that OCR cannot read can ever be
  // attached, now that a refused card is removed again - and the office's own
  // PAN card is one of those, its name coming back a character wrong under every
  // setting tried.
  const acceptedOnTrust = input.identityOverrideReason
  const checked = !acceptedOnTrust && (await isCheckedType(record.documentTypeId))

  const identity: AttachIdentityCheck = acceptedOnTrust
    ? {
        status: 'Overridden',
        source: null,
        checks: [],
        overrideBy: actor.userId,
        overrideReason: acceptedOnTrust,
      }
    : {
        status: checked ? 'Checking' : 'NotChecked',
        source: null,
        checks: [],
        overrideBy: null,
        overrideReason: null,
      }

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
      identity,
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
      identityCheck: identity.status,
      ...summariseChecks(identity.checks),
    },
  })

  // A second entry, on purpose. An override is the event a reviewer looks for,
  // and it should not have to be found by reading the metadata of every upload.
  if (identity.status === 'Overridden') {
    await audit.record({
      userId: actor.userId,
      action: AUDIT_ACTIONS.DOCUMENT_IDENTITY_OVERRIDDEN,
      entityType: AUDIT_ENTITY_TYPES.DOCUMENT,
      entityId: documentId,
      ipAddress: context.ipAddress,
      metadata: {
        employeeCode: record.employeeCode,
        documentName: record.documentName,
        source: identity.source,
        reason: identity.overrideReason,
        ...summariseChecks(identity.checks),
      },
    })
  }

  // Reading starts here and is NOT waited for. The upload is finished: the file
  // is stored, the row points at it, and the audit entry is written. What is
  // still to come is the verdict, which arrives on the row a few seconds later.
  //
  // Deliberately not awaited, and deliberately not able to reject: an unhandled
  // rejection from a background task takes the process down, and a reading that
  // goes wrong must never cost the upload that already succeeded.
  if (identity.status === 'Checking') {
    void completeIdentityCheck(documentId, stored.storedFileName, actor, context).catch((error) => {
      logger.error({ err: error, documentId }, 'The background identity check threw')
    })
  }

  return getById(documentId)
}

/**
 * Accepts a document the check refused.
 *
 * The override used to travel with the upload, because the check ran inside it
 * and a refusal meant nothing was stored. Now the document is already on file
 * and this is a decision about it: a person who has looked at the page says why
 * it is right, and their name goes on that sentence.
 *
 * Only a refused document can be accepted this way. Overriding a check that
 * passed, or one still running, would put a reason on a row that never needed
 * one and make the field impossible to read as evidence of anything.
 */
export async function overrideIdentityCheck(
  documentId: number,
  reason: string,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeDocument> {
  const record = await loadRecord(documentId)
  const location = await employeeDocumentRepository.findStoredFile(documentId)

  if (record.identityCheck?.status !== 'Failed') {
    throw new ConflictError(
      record.identityCheck?.status === 'Checking'
        ? 'This document is still being read. Wait for the result before accepting it.'
        : 'This document was not refused, so there is nothing to accept.',
    )
  }
  if (!location?.storedFileName) {
    throw new ConflictError('This document has no stored file.')
  }

  const written = await employeeDocumentRepository.recordIdentityCheck({
    documentId,
    storedFileName: location.storedFileName,
    status: 'Overridden',
    source: record.identityCheck.source,
    checks: record.identityCheck.checks,
    reason,
    overrideBy: actor.userId,
  })
  if (!written) throw concurrentChange()

  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.DOCUMENT_IDENTITY_OVERRIDDEN,
    entityType: AUDIT_ENTITY_TYPES.DOCUMENT,
    entityId: documentId,
    ipAddress: context.ipAddress,
    metadata: {
      employeeCode: record.employeeCode,
      documentName: record.documentName,
      source: record.identityCheck.source,
      reason,
      ...summariseChecks(record.identityCheck.checks),
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

/**
 * Takes the file off a document, returning the row to Pending.
 *
 * The remedy for a file uploaded against the wrong row or the wrong employee.
 * With no rejection step there is otherwise no way to undo it, and replacing a
 * wrong file with a right one is not always possible - the right one may not
 * have arrived yet.
 *
 * Requires DOCUMENT_REPLACE, because that is what this is: replacing a file with
 * nothing. Somebody trusted to overwrite a document is trusted to remove one.
 *
 * The bytes stay on disk. Only the current file is ever served, so an unlinked
 * one costs a little space and is the only thing standing between a mis-click
 * and a document nobody kept a copy of.
 */
export async function removeFile(
  documentId: number,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeDocument> {
  const record = await loadRecord(documentId)

  if (!roleHasPermission(actor.role, PERMISSIONS.DOCUMENT_REPLACE)) {
    throw new ForbiddenError('You do not have permission to remove a document.')
  }
  if (record.originalFileName === null) {
    throw new ConflictError('There is no file on this document to remove.')
  }

  // The placements describe pages in a file that is about to stop being served,
  // so they go with it rather than being left pointing at nothing.
  await signaturePlacementRepository.replaceForDocument(
    documentId,
    record.employeeId,
    [],
    actor.userId,
  )

  const cleared = await employeeDocumentRepository.clearFile(
    documentId,
    record.requiresSignature ? SIGNATURE_STATUS.PENDING_DETECTION : SIGNATURE_STATUS.NOT_REQUIRED,
  )
  if (!cleared) {
    // Somebody removed or replaced it between the read and the write.
    throw new ConflictError('That document changed while you were working on it.')
  }

  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.DOCUMENT_FILE_REMOVED,
    entityType: AUDIT_ENTITY_TYPES.DOCUMENT,
    entityId: documentId,
    ipAddress: context.ipAddress,
    // The file name is recorded because it is the only way to answer "what was
    // taken off this row" once the row no longer mentions it.
    metadata: {
      employeeCode: record.employeeCode,
      documentName: record.documentName,
      removedFileName: record.originalFileName,
    },
  })

  return getById(documentId)
}

/**
 * One line of the documents list, as the browser reads it.
 *
 * The deadline state is DERIVED here, by the same shared function every other
 * screen uses, rather than read from a column - so 'Overdue' is true the day it
 * becomes true, with no job to run and no stale flag to reconcile.
 */
export interface DocumentListItem extends DocumentListRecord {
  deadlineState: DeadlineState
  /** Positive = days remaining. Negative = days overdue. Null = no deadline. */
  daysRemaining: number | null
}

/**
 * Every checklist row in the company, filtered and paged.
 *
 * This is what the dashboard's document tiles open. They count ROWS - 'Still to
 * come 57' is fifty-seven documents, not fifty-seven people - so what they open
 * has to be a list of rows, each naming an employee and a document.
 *
 * Nobody who has left is in it, which is what makes the tile and the list agree
 * on the number.
 */
export async function list(
  query: DocumentListQuery,
): Promise<Paginated<DocumentListItem>> {
  const { rows, total } = await employeeDocumentRepository.listAll(query)

  return {
    items: rows.map((row) => {
      const deadline = deriveDeadline(row.dueDate, row.status)
      return { ...row, deadlineState: deadline.state, daysRemaining: deadline.daysRemaining }
    }),
    page: query.page,
    pageSize: query.pageSize,
    totalCount: total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  }
}