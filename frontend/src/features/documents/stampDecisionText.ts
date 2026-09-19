import { SIGNATURE_STATUS, STAMP_OUTCOMES, type EmployeeDocument } from '@asps-dms/shared'

/**
 * What the checklist says about stamping on upload: whether it happened,
 * and nothing else.
 *
 * It used to say why - four lines of amber under every document - and a
 * person glancing at the page read it as something gone wrong, when in most
 * cases nothing had: a box already had a signature in it, which is normal.
 * So: three words, in a quiet tone, and no reasons anywhere on the screen.
 * The decision row keeps everything, and npm run auto-stamp -- --report
 * prints it for whoever wants to look.
 *
 * NOTHING IN REPORT MODE. Nothing is stamped in report mode by definition,
 * so 'Not stamped' under every document for the whole trial would be noise
 * and not news. The line starts appearing when AUTO_STAMP is set to stamp
 * and it says something about that document.
 */

export type StampDecisionLine = 'Stamped automatically' | 'Partly stamped' | 'Not stamped'

export function describeStampDecision(
  item: Pick<EmployeeDocument, 'signatureStatus' | 'stampDecision'>,
): StampDecisionLine | null {
  const decision = item.stampDecision
  if (!decision || decision.mode !== 'Stamp') return null

  if (item.signatureStatus === SIGNATURE_STATUS.ADDED) {
    // Signed by the template, not by HR in the editor: only a decision that
    // stamped every box leaves a document Added on its own.
    return decision.outcome === STAMP_OUTCOMES.STAMPED ? 'Stamped automatically' : null
  }
  if (item.signatureStatus === SIGNATURE_STATUS.REVIEW_REQUIRED) {
    return decision.outcome === STAMP_OUTCOMES.PARTIAL ? 'Partly stamped' : 'Not stamped'
  }
  // Skipped, not required, or moved on by hand: the decision is history.
  return null
}
