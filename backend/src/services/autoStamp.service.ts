import {
  PHOTO_DOCUMENT_CODE,
  SIGNATURE_STATUS,
  SIGNER_ROLES,
  SIGNER_ROLE_LABEL,
  STAMP_OUTCOMES,
  exactVariantKey,
  isSignatureRole,
  type DocumentTypePlacement,
  type SignatureStatus,
  type SignerRole,
  type StampBoxDecision,
  type StampOutcome,
  type TemplateVariant,
} from '@asps-dms/shared'
import type { BoxAssessment } from './boxOccupancy.service.js'
import type { StampCheckResult } from './stampCheck.service.js'

/**
 * Stamping on upload: the decision.
 *
 * A document is uploaded. If its type has a template and the file matches one
 * of the template's variants, the signatures are stamped where the template
 * says - no screen, no approval. The employee's signature is the one on their
 * record, which comes from MMC's own folder; the authoriser's is the
 * uploader's; the photograph is the employee's. A wrong signature is a wrong
 * file in MMC's folder, which is not a decision this system should put to HR.
 *
 * WHAT IS NEVER DONE IS GUESSED AT. A box is left alone when something is
 * already in it, when the image it needs is not on file, when the file matches
 * no template or more than one, and when the identity check said the file may
 * not be this employee's at all. Left alone is not refused: the rest of the
 * boxes are still stamped, and the document is marked for HR to look at, with
 * the reason on it, so nothing is silently half done.
 *
 * THIS MODULE IS PURE. It takes what was measured - the template match and
 * the occupancy of each box, from stampCheck - and what is on file, and says
 * what to do. Reading the database, the folder and the file, and the stamping
 * itself, happen in the runner; the rules that HR would argue about are here,
 * testable against plain values with no PDF in sight.
 */

/** What the identity check had settled on when the decision was made. */
export type IdentityOutcome = 'Passed' | 'Overridden' | 'NotChecked' | 'Checking' | 'Failed'

export interface DecideInput {
  documentCode: string
  documentName: string
  /**
   * The document codes the server is set to stamp - AUTO_STAMP_TYPES. A type
   * not in it is decided 'NotInList' before anything else is looked at, and
   * an empty set stamps nothing at all.
   */
  autoStampTypes: ReadonlySet<string>
  identityCheck: IdentityOutcome
  /**
   * The template match and every box's occupancy, from stampCheck. Null when
   * the type has no template rows at all - there was nothing to check
   * against.
   */
  check: StampCheckResult | null
  /** Every box of every variant of the type's template. */
  templateRows: readonly DocumentTypePlacement[]
  /** Which images are on file to stamp with. */
  images: {
    employeeSignature: boolean
    authoriserSignature: boolean
    photo: boolean
  }
}

/** One box of the matched variant, with what to do about it. */
export interface BoxPlan extends StampBoxDecision {
  template: DocumentTypePlacement
  occupancy: BoxAssessment | null
}

export interface Decision {
  outcome: StampOutcome
  variant: TemplateVariant | null
  boxes: BoxPlan[]
  /** The boxes to stamp, in template order. Empty unless something is. */
  toStamp: BoxPlan[]
  /** Where the document's signature status ends up, whatever the mode. */
  nextStatus: SignatureStatus
  /** One sentence, written for HR. */
  summary: string
}

/* -------------------------------------------------------------------------- */
/* The reasons, in the words HR reads                                           */
/* -------------------------------------------------------------------------- */

export const REASONS = {
  identityFailed:
    'the identity check failed, so this may not be the employee’s document; nothing is stamped on it',
  identityUnfinished: 'the identity check has not finished',
  notInList: (documentName: string) => `${documentName} is not in the auto-stamp list`,
  noTemplate: (documentName: string) => `${documentName} has no template`,
  noVariant: 'the file matches none of the template’s forms',
  ambiguousVariant: 'the file matches more than one of the template’s forms',
  notPdf: 'the file is not a PDF; templates are for the generated forms',
  unreadable: 'the file could not be opened',
  occupied: (found: string) => `the box already has something in it (${found})`,
  uncertain: (found: string) => `it is not clear whether the box is empty (${found})`,
  noEmployeeSignature: 'the employee has no signature on file',
  noAuthoriserSignature: 'the person who uploaded it has no signature on file',
  photoElsewhere: 'a photograph goes on the ESIC form only',
  noPhoto: 'the employee has no photograph on file',
} as const

function roleWord(role: SignerRole): string {
  return SIGNER_ROLE_LABEL[role].toLowerCase()
}

/* -------------------------------------------------------------------------- */
/* The decision                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The boxes of the saved template the file matched, each paired with what the
 * occupancy check found in it.
 *
 * The template's rows are picked out by its EXACT key - the sample size it
 * was drawn on - and never by the rounded shape key, which would gather the
 * rows of every older template of the same shape as well and stamp each of
 * their boxes. stampCheck chose the one template and assessed its boxes in
 * row order, labelling each with its index; the pairing is by that label,
 * and a box the check did not assess is paired with nothing - which the
 * rules below treat as unknown, never as empty.
 */
function boxesOf(check: StampCheckResult, rows: readonly DocumentTypePlacement[]) {
  if (!check.variant) return []
  const key = exactVariantKey(check.variant)
  return rows
    .filter((row) => exactVariantKey(row.variant) === key)
    .map((template, index) => ({
      template,
      occupancy: check.boxes.find((box) => box.label === String(index)) ?? null,
    }))
}

/** What to do with one box: stamp it, or leave it alone and say why. */
function planBox(
  template: DocumentTypePlacement,
  occupancy: BoxAssessment | null,
  input: DecideInput,
): BoxPlan {
  const base = {
    template,
    occupancy,
    signerRole: template.signerRole,
    pageNumber: template.pageNumber,
    found: occupancy?.verdict ?? null,
  }
  const skip = (reason: string): BoxPlan => ({ ...base, action: 'skip', reason })

  // Nothing is painted over something already there, and nothing is painted
  // where it is not clear. A person can see the box; this cannot.
  if (!occupancy) return skip(REASONS.uncertain('the box was not checked'))
  if (occupancy.verdict === 'occupied') return skip(REASONS.occupied(occupancy.reason))
  if (occupancy.verdict === 'uncertain') return skip(REASONS.uncertain(occupancy.reason))

  switch (template.signerRole) {
    case SIGNER_ROLES.EMPLOYEE:
      if (!input.images.employeeSignature) return skip(REASONS.noEmployeeSignature)
      break
    case SIGNER_ROLES.AUTHORISER:
      // Left EMPTY rather than blocking the rest: an uploader with no signature
      // of their own must not stop the employee's going on. HR sees the gap.
      if (!input.images.authoriserSignature) return skip(REASONS.noAuthoriserSignature)
      break
    case SIGNER_ROLES.PHOTO:
      // The same rule the manual path enforces: the photograph goes on one
      // form only, whatever a template says.
      if (input.documentCode !== PHOTO_DOCUMENT_CODE) return skip(REASONS.photoElsewhere)
      if (!input.images.photo) return skip(REASONS.noPhoto)
      break
  }

  return { ...base, action: 'stamp', reason: null }
}

/** A document that goes nowhere: nothing to stamp, HR to look, one reason. */
function nothing(outcome: StampOutcome, reason: string): Decision {
  return {
    outcome,
    variant: null,
    boxes: [],
    toStamp: [],
    nextStatus: SIGNATURE_STATUS.REVIEW_REQUIRED,
    summary: `Not stamped: ${reason}.`,
  }
}

/**
 * Decides what to stamp on an uploaded document, and what to say about it.
 *
 * The document ends in ADDED only when every box of the template was stamped
 * - a photograph included. An HR box left empty because the uploader has no
 * signature, or a photograph box with no photograph behind it, is a document
 * with something still missing, and it goes to REVIEW_REQUIRED so that HR
 * sees it, with the reason. Stamping the rest first is what makes that a
 * finishing job rather than a signing job.
 */
export function decide(input: DecideInput): Decision {
  // The list first: a type the server is not set to stamp is left for HR
  // whatever else is true of the file. Not a failure - MMC signs most forms
  // itself, and this is how the application knows which ones it does not.
  if (!input.autoStampTypes.has(input.documentCode)) {
    return nothing(STAMP_OUTCOMES.NOT_IN_LIST, REASONS.notInList(input.documentName))
  }

  // The identity check next, before the file is even looked at. A document
  // filed against the wrong employee must never get this employee's signature
  // on it, however well it matches a template.
  if (input.identityCheck === 'Failed') {
    return nothing(STAMP_OUTCOMES.IDENTITY_FAILED, REASONS.identityFailed)
  }
  if (input.identityCheck === 'Checking') {
    return nothing(STAMP_OUTCOMES.FAILED, REASONS.identityUnfinished)
  }

  if (input.templateRows.length === 0 || input.check === null) {
    return nothing(STAMP_OUTCOMES.NO_TEMPLATE, REASONS.noTemplate(input.documentName))
  }

  const { check } = input
  switch (check.outcome) {
    case 'noVariant':
      return nothing(STAMP_OUTCOMES.NO_VARIANT, REASONS.noVariant)
    case 'ambiguousVariant':
      return nothing(STAMP_OUTCOMES.AMBIGUOUS_VARIANT, REASONS.ambiguousVariant)
    case 'notPdf':
      return nothing(STAMP_OUTCOMES.NOT_PDF, REASONS.notPdf)
    case 'unreadable':
      return nothing(STAMP_OUTCOMES.UNREADABLE, REASONS.unreadable)
    case 'checked':
      break
  }

  const boxes = boxesOf(check, input.templateRows).map(({ template, occupancy }) =>
    planBox(template, occupancy, input),
  )
  const toStamp = boxes.filter((box) => box.action === 'stamp')
  const skipped = boxes.filter((box) => box.action === 'skip')

  const outcome: StampOutcome =
    skipped.length === 0
      ? STAMP_OUTCOMES.STAMPED
      : toStamp.length === 0
        ? STAMP_OUTCOMES.NOTHING
        : STAMP_OUTCOMES.PARTIAL

  // Added only when nothing is left to do. A stamped photograph alone is not
  // a signed document, exactly as on the manual path.
  const complete = skipped.length === 0 && toStamp.some((box) => isSignatureRole(box.signerRole))

  return {
    outcome,
    variant: check.variant,
    boxes,
    toStamp,
    nextStatus: complete ? SIGNATURE_STATUS.ADDED : SIGNATURE_STATUS.REVIEW_REQUIRED,
    summary:
      summarise(toStamp, skipped) +
      (check.templatesInShape > 1
        ? ` (${check.templatesInShape} saved templates are this shape; the newest was used.)`
        : ''),
  }
}

/**
 * The sentence HR reads: what went on, and what did not and why.
 *
 * Reasons are given once each with the boxes they apply to, so two boxes
 * refused for the same cause read as one fact rather than two complaints.
 */
function summarise(toStamp: readonly BoxPlan[], skipped: readonly BoxPlan[]): string {
  const parts: string[] = []

  if (toStamp.length > 0) {
    parts.push(`Stamped: ${listRoles(toStamp)}.`)
  }

  if (skipped.length > 0) {
    const byReason = new Map<string, BoxPlan[]>()
    for (const box of skipped) {
      const reason = box.reason ?? 'no reason recorded'
      byReason.set(reason, [...(byReason.get(reason) ?? []), box])
    }
    const clauses = [...byReason.entries()].map(
      ([reason, boxes]) => `the ${listRoles(boxes)} - ${reason}`,
    )
    parts.push(`Not stamped: ${clauses.join('; ')}.`)
  }

  return parts.join(' ')
}

function listRoles(boxes: readonly BoxPlan[]): string {
  const words = boxes.map((box) =>
    boxes.filter((other) => other.signerRole === box.signerRole).length > 1
      ? `${roleWord(box.signerRole)} on page ${box.pageNumber}`
      : roleWord(box.signerRole),
  )
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}
