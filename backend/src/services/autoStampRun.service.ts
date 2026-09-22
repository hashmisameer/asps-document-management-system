import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  AUTO_STAMP_MODES,
  SIGNATURE_STATUS,
  SIGNER_ROLES,
  SIGNER_ROLE_LABEL,
  STAMP_OUTCOMES,
  exactVariantKey,
  type AuthUser,
  type AutoStampMode,
  type SignaturePlacement,
  type SignatureStatus,
  type StampBoxDecision,
} from '@asps-dms/shared'
import { env } from '../config/env.js'
import * as documentTypePlacementRepository from '../repositories/documentTypePlacement.repository.js'
import * as employeeDocumentRepository from '../repositories/employeeDocument.repository.js'
import type { AwaitingSignatureRow } from '../repositories/employeeDocument.repository.js'
import * as employeeRepository from '../repositories/employee.repository.js'
import * as employeeSignatureRepository from '../repositories/employeeSignature.repository.js'
import * as signaturePlacementRepository from '../repositories/signaturePlacement.repository.js'
import * as stampDecisionRepository from '../repositories/stampDecision.repository.js'
import * as userRepository from '../repositories/user.repository.js'
import * as userSignatureRepository from '../repositories/userSignature.repository.js'
import { logger } from '../utils/logger.js'
import * as audit from './audit.service.js'
import type { RequestContext } from './auth.service.js'
import { decide, type Decision, type ExistingPlacement } from './autoStamp.service.js'
import { attachQuietly } from './mmcImages.service.js'
import {
  applyPlacements,
  readPhotoForStamp,
  readSignatureImages,
  type StampBox,
} from './signature.service.js'
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
 * A DOCUMENT IS DECIDED ABOUT AGAIN when the employee's signature or
 * photograph arrives after the upload - from MMC's folder, by hand on the
 * record, or on the pad - and by the re-decide command for the ones that
 * waited before this existed. Everything already on the document is kept and
 * repainted with what is added; a document with nothing to add is left
 * exactly as it is. See prepare().
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
 * Why a document was left exactly as it was - not decided about, nothing
 * recorded, nothing painted.
 *
 *   notWaiting        no file, needs no signature, or not in a waiting status
 *   nothingToAdd      everything the template has is already on the page,
 *                     or what is missing cannot be added yet (the reasons are
 *                     in the detail); repainting would change nothing
 *   signerUnavailable an HR box already on the document was signed by an
 *                     account that has no signature now (or is gone);
 *                     repainting without that image would drop HR's box
 *   imageMissing      a kept box's image is no longer on file (a photograph
 *                     removed since it was placed)
 *   failed            the run threw; a Failed decision was recorded
 */
export type LeftReason =
  'notWaiting' | 'nothingToAdd' | 'signerUnavailable' | 'imageMissing' | 'failed'

export interface LeftAlone {
  documentId: number
  left: LeftReason
  detail: string
}

/** Where a run is taken from. Recorded in the audit trail. */
export type RunTrigger =
  | 'upload'
  | 'signature saved'
  | 'photo saved'
  | 'MMC pickup'
  | 'backlog command'
  | 'redecide command'

export interface RunOptions {
  trigger?: RunTrigger
}

/** Everything read for one decision, before anything is written. */
interface Prepared {
  document: NonNullable<Awaited<ReturnType<typeof employeeDocumentRepository.findById>>>
  startedFrom: SignatureStatus
  mode: AutoStampMode
  /** The account the run acts as - the caller's, or the signer of a kept HR box. */
  actor: AuthUser
  decision: Decision
  /** The placements already on the document, every one kept. */
  existing: SignaturePlacement[]
  location: Awaited<ReturnType<typeof employeeDocumentRepository.findStoredFile>>
  images: {
    employeeSignature: Awaited<ReturnType<typeof employeeSignatureRepository.findActiveByEmployee>>
    authoriserSignature: Awaited<ReturnType<typeof userSignatureRepository.findActiveByUser>>
    photo: Awaited<ReturnType<typeof readPhotoForStamp>>
  }
}

function isLeft<T extends object>(value: T | LeftAlone): value is LeftAlone {
  return 'left' in value
}

function toExisting(rows: readonly SignaturePlacement[]): ExistingPlacement[] {
  return rows.map((row) => ({
    signerRole: row.signerRole,
    pageNumber: row.pageNumber,
    rect: { x: row.x, y: row.y, width: row.width, height: row.height },
    method: row.method,
  }))
}

/** An account that may still act: exists and is active. */
async function activeUser(userId: number): Promise<AuthUser | null> {
  const user = await userRepository.findById(userId)
  return user && user.isActive ? userRepository.toAuthUser(user) : null
}

/**
 * Reads everything a decision needs and decides. Writes nothing - with
 * `attach` off, not even to the record - so a dry run is this and printing.
 *
 * A document that already carries placements is decided against them: every
 * one is kept, and only roles missing from a page are candidates. When one
 * of the kept boxes is an HR box, the run acts AS ITS SIGNER, because the HR
 * image painted is the actor's: repainting the document as somebody else
 * would put their signature in a box that says it is HR's. If that account
 * has no signature now, the document is left alone rather than lose the box.
 */
/** A document waiting for a signature, with a file to sign - or why not. */
async function loadWaiting(documentId: number): Promise<Waiting | LeftAlone> {
  const document = await employeeDocumentRepository.findById(documentId)
  if (!document || !document.requiresSignature || document.originalFileName === null) {
    return { documentId, left: 'notWaiting', detail: 'no file, or no signature needed' }
  }
  if (
    document.signatureStatus !== SIGNATURE_STATUS.PENDING_DETECTION &&
    document.signatureStatus !== SIGNATURE_STATUS.REVIEW_REQUIRED
  ) {
    return {
      documentId,
      left: 'notWaiting',
      detail: `the signature is '${document.signatureStatus}'`,
    }
  }
  return { document, startedFrom: document.signatureStatus }
}

interface Waiting {
  document: Prepared['document']
  startedFrom: SignatureStatus
}

async function prepare(
  waiting: Waiting,
  caller: AuthUser,
  context: RequestContext,
  options: { attach: boolean },
): Promise<Prepared | LeftAlone> {
  const mode = modeFromEnv()
  const { document, startedFrom } = waiting
  const documentId = document.documentId

  // The MMC folder is looked in once, so a signature or a photograph that
  // appeared there since the record was created is on the record before the
  // decision is made. Never throws; attaches only where nothing is.
  if (options.attach) {
    const employee = await employeeRepository.findById(document.employeeId)
    if (employee) await attachQuietly(employee, caller, context)
  }

  const autoStampTypes = typesFromEnv()
  const base = {
    documentCode: document.documentCode,
    documentName: document.documentName,
    autoStampTypes,
    identityCheck: document.identityCheck?.status ?? 'NotChecked',
  } as const

  // A type not in the list is decided here, with nothing read: not the file,
  // not the template, not the images.
  if (!autoStampTypes.has(document.documentCode)) {
    return {
      document,
      startedFrom,
      mode,
      actor: caller,
      decision: decide({
        ...base,
        check: null,
        templateRows: [],
        images: { employeeSignature: false, authoriserSignature: false, photo: false },
        existing: [],
      }),
      existing: [],
      location: null,
      images: { employeeSignature: null, authoriserSignature: null, photo: null },
    }
  }

  const existing = await signaturePlacementRepository.listForDocument(documentId)

  // A kept HR box names its signer; the run acts as them.
  let actor = caller
  const hrBox = existing.find((row) => row.signerRole === SIGNER_ROLES.AUTHORISER)
  if (hrBox?.signerUserId && hrBox.signerUserId !== caller.userId) {
    const signer = await activeUser(hrBox.signerUserId)
    if (!signer) {
      return {
        documentId,
        left: 'signerUnavailable',
        detail: `the hr signature on it was placed by ${hrBox.signerName ?? `user ${hrBox.signerUserId}`}, whose account is no longer active`,
      }
    }
    actor = signer
  }

  const [location, templateRows, employeeSignature, authoriserSignature, photo] = await Promise.all(
    [
      employeeDocumentRepository.findStoredFile(documentId),
      documentTypePlacementRepository.listForType(document.documentTypeId),
      employeeSignatureRepository.findActiveByEmployee(document.employeeId),
      userSignatureRepository.findActiveByUser(actor.userId),
      readPhotoForStamp(document.employeeId),
    ],
  )
  if (!location?.originalFilePath) {
    return { documentId, left: 'notWaiting', detail: 'no stored file' }
  }

  // Every kept box is repainted, so every kept box needs its image.
  const images = { employeeSignature, authoriserSignature, photo }
  const missing = existing.find(
    (row) =>
      (row.signerRole === SIGNER_ROLES.EMPLOYEE && !employeeSignature) ||
      (row.signerRole === SIGNER_ROLES.AUTHORISER && !authoriserSignature) ||
      (row.signerRole === SIGNER_ROLES.PHOTO && !photo),
  )
  if (missing) {
    const who =
      missing.signerRole === SIGNER_ROLES.AUTHORISER
        ? `${actor.fullName} has no signature on file`
        : missing.signerRole === SIGNER_ROLES.PHOTO
          ? 'the employee has no photograph on file'
          : 'the employee has no signature on file'
    return {
      documentId,
      left: missing.signerRole === SIGNER_ROLES.AUTHORISER ? 'signerUnavailable' : 'imageMissing',
      detail: `the ${SIGNER_ROLE_LABEL[missing.signerRole].toLowerCase()} already on it cannot be repainted: ${who}`,
    }
  }

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
    ...base,
    check,
    templateRows,
    images: {
      employeeSignature: employeeSignature !== null,
      authoriserSignature: authoriserSignature !== null,
      photo: photo !== null,
    },
    existing: toExisting(existing),
  })

  // A document that already carries something and gets nothing new is left
  // exactly as it is: no repaint, no row, no status change. The reasons say
  // what is still missing, or that nothing is.
  if (existing.length > 0 && decision.toStamp.length === 0) {
    const still = decision.boxes.filter((box) => box.action === 'skip')
    return {
      documentId,
      left: 'nothingToAdd',
      detail:
        still.length === 0
          ? 'every box the template has is already on it'
          : `still missing: ${still.map((box) => `the ${SIGNER_ROLE_LABEL[box.signerRole].toLowerCase()} - ${box.reason}`).join('; ')}`,
    }
  }

  return { document, startedFrom, mode, actor, decision, existing, location, images }
}

/** The kept placements, as they are, plus the template boxes to add. */
function boxesToApply(prepared: Prepared): StampBox[] {
  const kept: StampBox[] = prepared.existing.map((row) => ({
    pageNumber: row.pageNumber,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    pageRotation: row.pageRotation,
    signerRole: row.signerRole,
    method: row.method,
    detectionMethod: row.detectionMethod,
    confidence: row.confidence,
    signerUserId: row.signerUserId,
  }))
  const added: StampBox[] = prepared.decision.toStamp.map((box) => ({
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
  }))
  return [...kept, ...added]
}

/**
 * Decides about one document and, in stamp mode, stamps it.
 *
 * Returns null for a document this does not apply to or left as it was: no
 * file, a type that needs no signature, a status that is not waiting, or
 * nothing to add to what is already on it (runOne() says which). Never
 * throws: a run that goes wrong is recorded as a decision that failed, and
 * the document is sent to HR rather than left stuck.
 */
export async function run(
  documentId: number,
  actor: AuthUser,
  context: RequestContext,
  options: RunOptions = {},
): Promise<RunResult | null> {
  const outcome = await runOne(documentId, actor, context, options)
  return 'left' in outcome ? null : outcome
}

/** run(), saying why when the document was left alone. */
export async function runOne(
  documentId: number,
  caller: AuthUser,
  context: RequestContext,
  options: RunOptions = {},
): Promise<RunResult | LeftAlone> {
  const trigger = options.trigger ?? 'upload'
  const waiting = await loadWaiting(documentId)
  if (isLeft(waiting)) return waiting
  const { startedFrom } = waiting

  try {
    const prepared = await prepare(waiting, caller, context, { attach: true })
    if (isLeft(prepared)) {
      logger.info({ documentId, left: prepared.left, detail: prepared.detail }, 'Left alone')
      return prepared
    }
    const { document, mode, actor, decision, location, images } = prepared

    // 'NotInList' is recorded once and not on every visit: the pickup and the
    // saves re-decide an employee's waiting documents each time something
    // arrives for them.
    if (decision.outcome === STAMP_OUTCOMES.NOT_IN_LIST) {
      const latest = await stampDecisionRepository.findLatestForDocument(documentId)
      if (latest?.outcome !== STAMP_OUTCOMES.NOT_IN_LIST) {
        await recordDecision(documentId, mode, decision, actor, context, trigger)
      }
      await settle(documentId, startedFrom, SIGNATURE_STATUS.REVIEW_REQUIRED)
      return { documentId, mode, decision, stamped: 0, status: SIGNATURE_STATUS.REVIEW_REQUIRED }
    }

    await recordDecision(documentId, mode, decision, actor, context, trigger)

    // Stamping, only when set to and only when there is something to stamp.
    // The boxes are the template's plus everything already on the document;
    // the images are whichever those call for, read the way the editor reads
    // them.
    if (mode === AUTO_STAMP_MODES.STAMP && decision.toStamp.length > 0 && location) {
      const boxes = boxesToApply(prepared)
      const roles = new Set(boxes.map((box) => box.signerRole))
      const signatures = await readSignatureImages({
        employee: roles.has(SIGNER_ROLES.EMPLOYEE) ? images.employeeSignature : null,
        authoriser: roles.has(SIGNER_ROLES.AUTHORISER) ? images.authoriserSignature : null,
        photo: roles.has(SIGNER_ROLES.PHOTO) ? images.photo : null,
      })

      await applyPlacements({
        document,
        originalFilePath: location.originalFilePath as string,
        sourceMimeType: location.mimeType ?? 'application/pdf',
        boxes,
        signatures,
        nextStatus: decision.nextStatus,
        actor,
        context,
        auditAction: AUDIT_ACTIONS.SIGNATURE_PLACED_FROM_TEMPLATE,
        auditMetadata: {
          trigger,
          variant: decision.variant ? exactVariantKey(decision.variant) : null,
          added: decision.toStamp.map((box) => ({
            signerRole: box.signerRole,
            page: box.pageNumber,
          })),
          kept: prepared.existing.map((row) => ({
            signerRole: row.signerRole,
            page: row.pageNumber,
            method: row.method,
          })),
          leftAlone: decision.boxes
            .filter((box) => box.action === 'skip')
            .map((box) => ({
              signerRole: box.signerRole,
              page: box.pageNumber,
              reason: box.reason,
            })),
        },
      })

      return {
        documentId,
        mode,
        decision,
        stamped: decision.toStamp.length,
        status: decision.nextStatus,
      }
    }

    // Nothing was painted - report mode, or nothing to paint - so the
    // document goes to HR whatever the decision would have finished as.
    await settle(documentId, startedFrom, SIGNATURE_STATUS.REVIEW_REQUIRED)
    return { documentId, mode, decision, stamped: 0, status: SIGNATURE_STATUS.REVIEW_REQUIRED }
  } catch (error) {
    // The upload is safe and the file is stored. What is lost is this
    // decision, and that is recorded as such rather than left as a spinner.
    logger.error({ err: error, documentId }, 'Stamping on upload could not be completed')
    const message = error instanceof Error ? error.message : String(error)
    try {
      await stampDecisionRepository.insert({
        documentId,
        mode: modeFromEnv(),
        outcome: STAMP_OUTCOMES.FAILED,
        variantKey: null,
        stampedCount: 0,
        skippedCount: 0,
        summary: `Not stamped: the check could not be run (${message}).`.slice(0, 500),
        boxes: [],
        decidedBy: caller.userId,
      })
      await settle(documentId, startedFrom, SIGNATURE_STATUS.REVIEW_REQUIRED)
    } catch (secondary) {
      logger.error({ err: secondary, documentId }, 'Could not record the failed stamping decision')
    }
    return { documentId, left: 'failed', detail: `the run failed: ${message}` }
  }
}

/* -------------------------------------------------------------------------- */
/* Deciding again, when an image arrives                                        */
/* -------------------------------------------------------------------------- */

/** What became of one document that was looked at again. */
export type RedecideOutcome =
  | { documentId: number; documentName: string; kind: 'left'; reason: LeftReason; detail: string }
  | { documentId: number; documentName: string; kind: 'preview'; decision: Decision }
  | { documentId: number; documentName: string; kind: 'decided'; result: RunResult }

/** A breath between documents, so many arriving at once is quiet work, not a spike. */
export const BETWEEN_DOCUMENTS_MS = 250

export interface RedecideDeps {
  mode: () => AutoStampMode
  types: () => ReadonlySet<string>
  listAwaiting: typeof employeeDocumentRepository.listAwaitingSignature
  resolveUser: (userId: number) => Promise<AuthUser | null>
  runOne: typeof runOne
  sleep: (ms: number) => Promise<void>
}

function defaultRedecideDeps(): RedecideDeps {
  return {
    mode: modeFromEnv,
    types: typesFromEnv,
    listAwaiting: employeeDocumentRepository.listAwaitingSignature,
    resolveUser: activeUser,
    runOne,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

/**
 * Decides again about an employee's waiting documents, because their
 * signature or photograph has just been saved - by MMC's folder, by hand on
 * the record, or on the pad. Only in stamp mode, only the types in the list,
 * each in the name of the person who uploaded it (the caller's when that
 * account is gone), one at a time. Never throws: a save must not fail because
 * what followed it did.
 */
export async function redecideForEmployee(
  employeeId: number,
  caller: AuthUser,
  context: RequestContext,
  trigger: RunTrigger,
  deps: RedecideDeps = defaultRedecideDeps(),
): Promise<RedecideOutcome[]> {
  const outcomes: RedecideOutcome[] = []
  try {
    if (deps.mode() !== AUTO_STAMP_MODES.STAMP) return outcomes
    const types = deps.types()
    const waiting = (await deps.listAwaiting(employeeId)).filter((row) =>
      types.has(row.documentCode),
    )
    for (const [index, row] of waiting.entries()) {
      if (index > 0) await deps.sleep(BETWEEN_DOCUMENTS_MS)
      const uploader = row.uploadedBy ? await deps.resolveUser(row.uploadedBy) : null
      const outcome = await deps.runOne(row.documentId, uploader ?? caller, context, { trigger })
      outcomes.push(
        'left' in outcome
          ? {
              documentId: row.documentId,
              documentName: row.documentName,
              kind: 'left',
              reason: outcome.left,
              detail: outcome.detail,
            }
          : {
              documentId: row.documentId,
              documentName: row.documentName,
              kind: 'decided',
              result: outcome,
            },
      )
    }
  } catch (error) {
    logger.error({ err: error, employeeId, trigger }, 'Deciding again could not be completed')
  }
  return outcomes
}

/**
 * The same, for every waiting document of one type - the command. With
 * `dryRun` nothing is written: not the record, not a row, not a status; each
 * document is read and decided and the decision handed back for printing.
 */
export async function redecideType(
  rows: readonly AwaitingSignatureRow[],
  options: {
    dryRun: boolean
    fallback: AuthUser
    context: RequestContext
    resolveUploader: (userId: number) => Promise<AuthUser | null>
    onEach?: (outcome: RedecideOutcome) => void
    sleep?: (ms: number) => Promise<void>
  },
): Promise<RedecideOutcome[]> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const actors = new Map<number, AuthUser | null>()
  const outcomes: RedecideOutcome[] = []

  for (const [index, row] of rows.entries()) {
    if (index > 0 && !options.dryRun) await sleep(BETWEEN_DOCUMENTS_MS)
    let actor = row.uploadedBy === null ? null : actors.get(row.uploadedBy)
    if (actor === undefined && row.uploadedBy !== null) {
      actor = await options.resolveUploader(row.uploadedBy)
      actors.set(row.uploadedBy, actor)
    }
    const as = actor ?? options.fallback

    let outcome: RedecideOutcome
    if (options.dryRun) {
      const waiting = await loadWaiting(row.documentId)
      const prepared = isLeft(waiting)
        ? waiting
        : await prepare(waiting, as, options.context, { attach: false })
      outcome = isLeft(prepared)
        ? {
            documentId: row.documentId,
            documentName: row.documentName,
            kind: 'left',
            reason: prepared.left,
            detail: prepared.detail,
          }
        : {
            documentId: row.documentId,
            documentName: row.documentName,
            kind: 'preview',
            decision: prepared.decision,
          }
    } else {
      const result = await runOne(row.documentId, as, options.context, {
        trigger: 'redecide command',
      })
      outcome =
        'left' in result
          ? {
              documentId: row.documentId,
              documentName: row.documentName,
              kind: 'left',
              reason: result.left,
              detail: result.detail,
            }
          : { documentId: row.documentId, documentName: row.documentName, kind: 'decided', result }
    }
    outcomes.push(outcome)
    options.onEach?.(outcome)
  }

  return outcomes
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

    const result = await run(row.documentId, actor ?? options.fallback, options.context, {
      trigger: 'backlog command',
    })
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
  trigger: RunTrigger,
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
    // Kept boxes are done, not left alone.
    skippedCount: decision.boxes.filter((box) => box.action === 'skip').length,
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
      trigger,
      outcome: decision.outcome,
      variant: decision.variant ? exactVariantKey(decision.variant) : null,
      toStamp: decision.toStamp.length,
      kept: decision.kept.length,
      leftAlone: decision.boxes.filter((box) => box.action === 'skip').length,
      summary: decision.summary,
    },
  })
}
