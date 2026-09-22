import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  AUTO_STAMP_MODES,
  SIGNATURE_STATUS,
  STAMP_OUTCOMES,
  exactVariantKey,
  type AuthUser,
  type AutoStampMode,
  type SignatureStatus,
  type StampBoxDecision,
} from '@asps-dms/shared'
import { env } from '../config/env.js'
import * as documentTypePlacementRepository from '../repositories/documentTypePlacement.repository.js'
import * as employeeDocumentRepository from '../repositories/employeeDocument.repository.js'
import * as employeeRepository from '../repositories/employee.repository.js'
import * as employeeSignatureRepository from '../repositories/employeeSignature.repository.js'
import * as stampDecisionRepository from '../repositories/stampDecision.repository.js'
import * as userSignatureRepository from '../repositories/userSignature.repository.js'
import { logger } from '../utils/logger.js'
import * as audit from './audit.service.js'
import type { RequestContext } from './auth.service.js'
import { decide, type Decision } from './autoStamp.service.js'
import { attachQuietly } from './mmcImages.service.js'
import { applyPlacements, readPhotoForStamp, readSignatureImages } from './signature.service.js'
import { checkDocument } from './stampCheck.service.js'

/**
 * Stamping on upload: the runner.
 *
 * Everything autoStamp.service.ts deliberately does not do: reads the
 * document, the template, the folder and the images; hands what it found to
 * decide(); records the decision; and - when the server is set to stamp -
 * stamps. It runs AFTER the upload has been answered and after the identity
 * check has settled, so nothing here can fail the upload, and so nothing is
 * stamped on a file the check has said may not be this employee's.
 *
 * WHATEVER HAPPENS, THE DOCUMENT LEAVES 'PendingDetection'. That status used
 * to be where every uploaded document sat for ever, because nothing moved it;
 * the 'documents to sign' count looked for ReviewRequired and found nothing.
 * Now every run ends in ADDED (every box stamped) or REVIEW_REQUIRED (anything
 * left alone, or the run itself failed), with a decision row saying why - so
 * the count is right and HR can read the reason.
 *
 * REPORT MODE, the default, records the decision and stamps nothing. The
 * document still goes to REVIEW_REQUIRED, exactly as it would have with a box
 * left alone, and HR signs it as before. The rows are what the office reads
 * for a few days before AUTO_STAMP is set to stamp.
 *
 * ONLY THE TYPES IN AUTO_STAMP_TYPES ARE CANDIDATES. MMC prints the
 * employee's signature and the HR stamp on every form it generates except the
 * ESIC form, so every other type is decided 'NotInList' - recorded once, the
 * file and the template never read - and goes to REVIEW_REQUIRED for HR to
 * sign by hand or skip. An empty list stamps nothing whatever the mode.
 */

export interface RunResult {
  documentId: number
  mode: AutoStampMode
  decision: Decision
  /** Boxes actually painted. Zero in report mode, and when nothing was to be. */
  stamped: number
  status: SignatureStatus
}

function modeFromEnv(): AutoStampMode {
  return env.AUTO_STAMP === 'stamp' ? AUTO_STAMP_MODES.STAMP : AUTO_STAMP_MODES.REPORT
}

function typesFromEnv(): ReadonlySet<string> {
  return env.AUTO_STAMP_TYPES
}

/** Where a document that has been decided about, but not fully stamped, goes. */
async function settle(
  documentId: number,
  from: SignatureStatus,
  to: SignatureStatus,
): Promise<void> {
  if (from === to) return
  const moved = await employeeDocumentRepository.setSignatureStatus(documentId, from, to)
  if (!moved) {
    // Somebody - the editor, a replacement upload - moved it first. Theirs
    // stands; this run was about a document that no longer is as it was.
    logger.info({ documentId, from, to }, 'Stamping on upload: the status had already moved')
  }
}

/**
 * Decides about one document and, in stamp mode, stamps it.
 *
 * Returns null for a document this does not apply to: no file, or a type that
 * needs no signature, or a status that is not waiting for one. Never throws:
 * a run that goes wrong is recorded as a decision that failed, and the
 * document is sent to HR rather than left stuck.
 */
export async function run(
  documentId: number,
  actor: AuthUser,
  context: RequestContext,
): Promise<RunResult | null> {
  const mode = modeFromEnv()
  const document = await employeeDocumentRepository.findById(documentId)
  if (!document || !document.requiresSignature || document.originalFileName === null) return null
  if (
    document.signatureStatus !== SIGNATURE_STATUS.PENDING_DETECTION &&
    document.signatureStatus !== SIGNATURE_STATUS.REVIEW_REQUIRED
  ) {
    return null
  }
  const startedFrom = document.signatureStatus

  try {
    // The MMC folder is looked in once, so a signature or a photograph that
    // appeared there since the record was created is on the record before
    // the decision is made. Never throws; attaches only where nothing is.
    const employee = await employeeRepository.findById(document.employeeId)
    if (employee) await attachQuietly(employee, actor, context)

    // A type not in the list is decided here, with nothing read: not the
    // file, not the template, not the images. The MMC watcher re-decides an
    // employee's waiting documents each time something arrives for them, so
    // the same 'NotInList' is recorded once and not on every visit.
    const autoStampTypes = typesFromEnv()
    if (!autoStampTypes.has(document.documentCode)) {
      const decision = decide({
        documentCode: document.documentCode,
        documentName: document.documentName,
        autoStampTypes,
        identityCheck: document.identityCheck?.status ?? 'NotChecked',
        check: null,
        templateRows: [],
        images: { employeeSignature: false, authoriserSignature: false, photo: false },
      })
      const latest = await stampDecisionRepository.findLatestForDocument(documentId)
      if (latest?.outcome !== STAMP_OUTCOMES.NOT_IN_LIST) {
        await recordDecision(documentId, mode, decision, actor, context)
      }
      await settle(documentId, startedFrom, SIGNATURE_STATUS.REVIEW_REQUIRED)
      return { documentId, mode, decision, stamped: 0, status: SIGNATURE_STATUS.REVIEW_REQUIRED }
    }

    const [location, templateRows, employeeSignature, authoriserSignature, photo] =
      await Promise.all([
        employeeDocumentRepository.findStoredFile(documentId),
        documentTypePlacementRepository.listForType(document.documentTypeId),
        employeeSignatureRepository.findActiveByEmployee(document.employeeId),
        userSignatureRepository.findActiveByUser(actor.userId),
        readPhotoForStamp(document.employeeId),
      ])
    if (!location?.originalFilePath) return null

    const check =
      templateRows.length > 0
        ? await checkDocument(
            {
              documentId,
              documentTypeId: document.documentTypeId,
              documentCode: document.documentCode,
              documentName: document.documentName,
              mimeType: location.mimeType,
              pageCount: document.pageCount,
              signatureStatus: document.signatureStatus,
              hasProcessedFile: location.processedFilePath !== null,
              originalFilePath: location.originalFilePath,
            },
            templateRows,
          )
        : null

    const decision = decide({
      documentCode: document.documentCode,
      documentName: document.documentName,
      autoStampTypes,
      identityCheck: document.identityCheck?.status ?? 'NotChecked',
      check,
      templateRows,
      images: {
        employeeSignature: employeeSignature !== null,
        authoriserSignature: authoriserSignature !== null,
        photo: photo !== null,
      },
    })

    await recordDecision(documentId, mode, decision, actor, context)

    // Stamping, only when set to and only when there is something to stamp.
    // The boxes are the template's; the images are whichever the decision
    // called for, read the same way the editor reads them.
    let stamped = 0
    if (mode === AUTO_STAMP_MODES.STAMP && decision.toStamp.length > 0) {
      const roles = new Set(decision.toStamp.map((box) => box.signerRole))
      const signatures = await readSignatureImages({
        employee: roles.has('Employee') ? employeeSignature : null,
        authoriser: roles.has('Authoriser') ? authoriserSignature : null,
        photo: roles.has('Photo') ? photo : null,
      })

      await applyPlacements({
        document,
        originalFilePath: location.originalFilePath,
        sourceMimeType: location.mimeType ?? 'application/pdf',
        boxes: decision.toStamp.map((box) => ({
          pageNumber: box.template.pageNumber,
          x: box.template.x,
          y: box.template.y,
          width: box.template.width,
          height: box.template.height,
          pageRotation: box.template.pageRotation,
          signerRole: box.signerRole,
          method: 'Automatic',
          detectionMethod: 'Template',
          confidence: null,
        })),
        signatures,
        nextStatus: decision.nextStatus,
        actor,
        context,
        auditAction: AUDIT_ACTIONS.SIGNATURE_PLACED_FROM_TEMPLATE,
        auditMetadata: {
          variant: decision.variant ? exactVariantKey(decision.variant) : null,
          leftAlone: decision.boxes
            .filter((box) => box.action === 'skip')
            .map((box) => ({
              signerRole: box.signerRole,
              page: box.pageNumber,
              reason: box.reason,
            })),
        },
      })
      stamped = decision.toStamp.length

      return { documentId, mode, decision, stamped, status: decision.nextStatus }
    }

    // Nothing was painted - report mode, or nothing to paint - so the
    // document goes to HR whatever the decision would have finished as.
    await settle(documentId, startedFrom, SIGNATURE_STATUS.REVIEW_REQUIRED)
    return { documentId, mode, decision, stamped, status: SIGNATURE_STATUS.REVIEW_REQUIRED }
  } catch (error) {
    // The upload is safe and the file is stored. What is lost is this
    // decision, and that is recorded as such rather than left as a spinner.
    logger.error({ err: error, documentId }, 'Stamping on upload could not be completed')
    const message = error instanceof Error ? error.message : String(error)
    try {
      await stampDecisionRepository.insert({
        documentId,
        mode,
        outcome: STAMP_OUTCOMES.FAILED,
        variantKey: null,
        stampedCount: 0,
        skippedCount: 0,
        summary: `Not stamped: the check could not be run (${message}).`.slice(0, 500),
        boxes: [],
        decidedBy: actor.userId,
      })
      await settle(documentId, startedFrom, SIGNATURE_STATUS.REVIEW_REQUIRED)
    } catch (secondary) {
      logger.error({ err: secondary, documentId }, 'Could not record the failed stamping decision')
    }
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* The backlog                                                                  */
/* -------------------------------------------------------------------------- */

export interface BacklogOutcome {
  documentId: number
  documentName: string
  /** Null when the runner left the document as it was. */
  result: RunResult | null
  /** The uploader's account was gone, so the fallback signed for it. */
  usedFallback: boolean
}

/**
 * Decides about the documents uploaded before stamping on upload existed.
 *
 * Each goes through run() exactly as a fresh upload would, in the name of the
 * person who uploaded it - the HR box is theirs - and in the name of the
 * fallback when that account is deactivated or gone. In report mode this
 * records a decision and sends the document to HR; in stamp mode it stamps.
 * One document's failure never stops the next: run() never throws.
 */
export async function runBacklog(
  rows: readonly { documentId: number; documentName: string; uploadedBy: number | null }[],
  options: {
    fallback: AuthUser
    context: RequestContext
    /** The uploader's account, if it is still one to act in the name of. */
    resolveUploader: (userId: number) => Promise<AuthUser | null>
    onEach?: (outcome: BacklogOutcome) => void
  },
): Promise<BacklogOutcome[]> {
  const actors = new Map<number, AuthUser | null>()
  const outcomes: BacklogOutcome[] = []

  for (const row of rows) {
    let actor = row.uploadedBy === null ? null : actors.get(row.uploadedBy)
    if (actor === undefined && row.uploadedBy !== null) {
      actor = await options.resolveUploader(row.uploadedBy)
      actors.set(row.uploadedBy, actor)
    }

    const result = await run(row.documentId, actor ?? options.fallback, options.context)
    const outcome: BacklogOutcome = {
      documentId: row.documentId,
      documentName: row.documentName,
      result,
      usedFallback: !actor,
    }
    outcomes.push(outcome)
    options.onEach?.(outcome)
  }

  return outcomes
}

async function recordDecision(
  documentId: number,
  mode: AutoStampMode,
  decision: Decision,
  actor: AuthUser,
  context: RequestContext,
): Promise<void> {
  const boxes: StampBoxDecision[] = decision.boxes.map((box) => ({
    signerRole: box.signerRole,
    pageNumber: box.pageNumber,
    action: box.action,
    reason: box.reason,
    found: box.found,
  }))

  await stampDecisionRepository.insert({
    documentId,
    mode,
    outcome: decision.outcome,
    variantKey: decision.variant ? exactVariantKey(decision.variant) : null,
    stampedCount: decision.toStamp.length,
    skippedCount: decision.boxes.length - decision.toStamp.length,
    summary: decision.summary,
    boxes,
    decidedBy: actor.userId,
  })

  // The trail says what was decided; the table says it in detail. Both, so
  // 'why is there no HR signature on this' is answered wherever it is asked.
  await audit.record({
    userId: actor.userId,
    action: AUDIT_ACTIONS.AUTO_STAMP_DECIDED,
    entityType: AUDIT_ENTITY_TYPES.DOCUMENT,
    entityId: documentId,
    ipAddress: context.ipAddress,
    metadata: {
      mode,
      outcome: decision.outcome,
      variant: decision.variant ? exactVariantKey(decision.variant) : null,
      toStamp: decision.toStamp.length,
      leftAlone: decision.boxes.length - decision.toStamp.length,
      summary: decision.summary,
    },
  })
}
