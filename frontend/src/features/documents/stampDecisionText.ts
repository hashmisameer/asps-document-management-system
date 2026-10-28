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
 *
 * NOTHING FOR A TYPE NOT IN THE LIST. A document whose type the server is
 * not set to stamp was never a candidate; 'Not stamped' under it would read
 * as a problem where there is only a setting.
 *
 * ONE EXCEPTION TO 'NO REASONS': 'Check template'. A box the template
 * expects empty that arrived occupied is not a fault in the document but in
 * the template - most likely a box drawn over something printed on the form
 * - and nothing else on the screen would ever say so: it reads as 'Not
 * stamped', and a morning goes on finding out why. It should be rare, so it
 * does not become noise, and when it appears somebody has to go and move a
 * box. The full reason is in the decision row and in --report.
 */

export type StampDecisionLine =
  | 'Stamped automatically'
  | 'Partly stamped'
  | 'Not stamped'
  | 'Check template'

export function describeStampDecision(
  item: Pick<EmployeeDocument, 'signatureStatus' | 'stampDecision'>,
): StampDecisionLine | null {
  const decision = item.stampDecision
  if (!decision || decision.mode !== 'Stamp') return null
  if (decision.outcome === STAMP_OUTCOMES.NOT_IN_LIST) return null

  if (item.signatureStatus === SIGNATURE_STATUS.ADDED) {
    // Signed by the template, not by HR in the editor: only a decision that
    // left nothing to do - every box stamped, kept, or filled by MMC - leaves
    // a document Added on its own.
    return decision.outcome === STAMP_OUTCOMES.STAMPED ? 'Stamped automatically' : null
  }
  if (item.signatureStatus === SIGNATURE_STATUS.REVIEW_REQUIRED) {
    if (decision.boxes.some((box) => box.checkTemplate)) return 'Check template'
    return decision.outcome === STAMP_OUTCOMES.PARTIAL ? 'Partly stamped' : 'Not stamped'
  }
  // Skipped, not required, or moved on by hand: the decision is history.
  return null
}
