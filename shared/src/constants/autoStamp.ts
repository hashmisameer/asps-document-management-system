import type { SignerRole } from './documents.js'

/**
 * Stamping on upload: the vocabulary the server records and the screens read.
 *
 * A document is uploaded; if its type has a template and the file matches
 * one of the template's variants, the signatures are stamped where the
 * template says, with no screen and no approval. Every decision is recorded
 * - in dbo.StampDecisions on the server - in these terms, and a document with
 * any box left alone is marked for HR to look at.
 */

/** What the server is set to do with a decision. */
export const AUTO_STAMP_MODES = {
  /** Decide and record; stamp nothing. */
  REPORT: 'Report',
  /** Decide, record, and stamp. */
  STAMP: 'Stamp',
} as const

export type AutoStampMode = (typeof AUTO_STAMP_MODES)[keyof typeof AUTO_STAMP_MODES]

/** The decision for a document as a whole. */
export const STAMP_OUTCOMES = {
  /** Every box the template has was stamped (or, in report mode, would be). */
  STAMPED: 'Stamped',
  /** Some boxes were stamped and some left alone. */
  PARTIAL: 'Partial',
  /** The file matched a template and every box was left alone. */
  NOTHING: 'Nothing',
  /** The document type is not one the server is set to stamp (AUTO_STAMP_TYPES). */
  NOT_IN_LIST: 'NotInList',
  /** The document type has no template at all. */
  NO_TEMPLATE: 'NoTemplate',
  /** The type has templates, but none for this page count and page size. */
  NO_VARIANT: 'NoVariant',
  /** More than one template claims the file; it is stamped from neither. */
  AMBIGUOUS_VARIANT: 'AmbiguousVariant',
  /** A JPG or PNG: templates are for the office's generated PDF forms. */
  NOT_PDF: 'NotPdf',
  /** The file is recorded but cannot be opened. */
  UNREADABLE: 'Unreadable',
  /** The identity check said this may not be this employee's document. */
  IDENTITY_FAILED: 'IdentityFailed',
  /** The run itself threw; nothing was decided. */
  FAILED: 'Failed',
} as const

export type StampOutcome = (typeof STAMP_OUTCOMES)[keyof typeof STAMP_OUTCOMES]

export const STAMP_OUTCOME_LABEL: Readonly<Record<StampOutcome, string>> = {
  [STAMP_OUTCOMES.STAMPED]: 'Stamped',
  [STAMP_OUTCOMES.PARTIAL]: 'Partly stamped',
  [STAMP_OUTCOMES.NOTHING]: 'Nothing stamped',
  [STAMP_OUTCOMES.NOT_IN_LIST]: 'Not in the auto-stamp list',
  [STAMP_OUTCOMES.NO_TEMPLATE]: 'No template for this document type',
  [STAMP_OUTCOMES.NO_VARIANT]: 'No template for this form',
  [STAMP_OUTCOMES.AMBIGUOUS_VARIANT]: 'More than one template matches',
  [STAMP_OUTCOMES.NOT_PDF]: 'Not a PDF',
  [STAMP_OUTCOMES.UNREADABLE]: 'The file could not be read',
  [STAMP_OUTCOMES.IDENTITY_FAILED]: 'The identity check failed',
  [STAMP_OUTCOMES.FAILED]: 'The check could not be run',
}

/** What was decided for one box of the template. */
export interface StampBoxDecision {
  signerRole: SignerRole
  pageNumber: number
  /**
   * stamp  painted from the template
   * skip   left alone, with the reason
   * keep   a placement already on the document for this role and page - HR's
   *        by hand, or an earlier stamp - kept as it is and repainted with the
   *        rest. A kept box is done, not left alone.
   */
  action: 'stamp' | 'skip' | 'keep'
  /** Why it was left alone or kept. Null when stamped. */
  reason: string | null
  /** What the occupancy check found in the box, when it looked. */
  found: 'empty' | 'occupied' | 'uncertain' | null
}

/** The latest decision for a document, as the checklist shows it. */
export interface StampDecisionSummary {
  mode: AutoStampMode
  outcome: StampOutcome
  /** One sentence, written for HR. */
  summary: string
  stampedCount: number
  skippedCount: number
  boxes: StampBoxDecision[]
  decidedAt: string
}
