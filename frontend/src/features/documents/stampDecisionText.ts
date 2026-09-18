import { SIGNATURE_STATUS, STAMP_OUTCOMES, type EmployeeDocument } from '@asps-dms/shared'

/**
 * What the checklist says about stamping on upload, beside the Sign button.
 *
 * Said only when it is something HR has to act on: a document that is still
 * waiting for a signature and was not fully stamped when it was uploaded. A
 * document that was stamped whole says so through the Sign button's tick,
 * and one that needs no signature says nothing here at all.
 *
 * Kept apart from the table so the sentences can be tested without a row
 * on screen.
 */

export interface StampDecisionLine {
  /** 'Not stamped automatically' or 'Partly stamped automatically'. */
  heading: string
  /** The server's own sentence: what went on, what did not, and why. */
  detail: string
  /** True in report mode: nothing was stamped, however the decision read. */
  reportOnly: boolean
}

export function describeStampDecision(
  item: Pick<EmployeeDocument, 'signatureStatus' | 'stampDecision'>,
): StampDecisionLine | null {
  const decision = item.stampDecision
  if (!decision) return null
  // Only while something is still to be done. Once signed - by the stamp or
  // by HR in the editor - or set aside, the decision is history.
  if (item.signatureStatus !== SIGNATURE_STATUS.REVIEW_REQUIRED) return null

  const reportOnly = decision.mode === 'Report'
  const partly = !reportOnly && decision.outcome === STAMP_OUTCOMES.PARTIAL

  return {
    heading: partly ? 'Partly stamped automatically' : 'Not stamped automatically',
    detail: reportOnly
      ? `Stamping on upload is in report mode, so nothing was stamped. It would have decided: ${decision.summary}`
      : decision.summary,
    reportOnly,
  }
}

/** The Sign button's tooltip, with the decision folded in when there is one. */
export function signLabel(base: string, line: StampDecisionLine | null): string {
  return line ? `${base} - ${line.heading.toLowerCase()}` : base
}
