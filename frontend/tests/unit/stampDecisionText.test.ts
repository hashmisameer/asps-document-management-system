import { describe, expect, it } from 'vitest'
import { SIGNATURE_STATUS, STAMP_OUTCOMES, type StampDecisionSummary } from '@asps-dms/shared'
import { describeStampDecision } from '../../src/features/documents/stampDecisionText.js'

/**
 * The line under a document about stamping on upload: whether it happened,
 * in three words, and nothing in report mode.
 */

function decision(overrides: Partial<StampDecisionSummary> = {}): StampDecisionSummary {
  return {
    mode: 'Stamp',
    outcome: STAMP_OUTCOMES.STAMPED,
    summary: 'Stamped: employee signature and hr signature.',
    stampedCount: 2,
    skippedCount: 0,
    boxes: [],
    decidedAt: '2026-09-18T04:11:00.000Z',
    ...overrides,
  }
}

const line = (signatureStatus: string, stampDecision: StampDecisionSummary | null) =>
  describeStampDecision({
    signatureStatus: signatureStatus as never,
    stampDecision,
  })

describe('describeStampDecision', () => {
  it('says a document the template signed was stamped automatically', () => {
    expect(line(SIGNATURE_STATUS.ADDED, decision())).toBe('Stamped automatically')
  })

  it('says partly stamped when some boxes were left alone', () => {
    expect(
      line(SIGNATURE_STATUS.REVIEW_REQUIRED, decision({ outcome: STAMP_OUTCOMES.PARTIAL })),
    ).toBe('Partly stamped')
  })

  it('says not stamped when nothing went on, whatever the reason', () => {
    for (const outcome of [
      STAMP_OUTCOMES.NOTHING,
      STAMP_OUTCOMES.NO_TEMPLATE,
      STAMP_OUTCOMES.NO_VARIANT,
      STAMP_OUTCOMES.NOT_PDF,
      STAMP_OUTCOMES.IDENTITY_FAILED,
      STAMP_OUTCOMES.FAILED,
    ]) {
      expect(line(SIGNATURE_STATUS.REVIEW_REQUIRED, decision({ outcome }))).toBe('Not stamped')
    }
  })

  it('never gives a reason', () => {
    const text = line(
      SIGNATURE_STATUS.REVIEW_REQUIRED,
      decision({ outcome: STAMP_OUTCOMES.NOTHING }),
    )
    expect(text).not.toContain('signature')
    expect(text).not.toContain('box')
  })

  it('says nothing at all in report mode - nothing is stamped there by definition', () => {
    expect(line(SIGNATURE_STATUS.REVIEW_REQUIRED, decision({ mode: 'Report' }))).toBeNull()
    expect(
      line(
        SIGNATURE_STATUS.REVIEW_REQUIRED,
        decision({ mode: 'Report', outcome: STAMP_OUTCOMES.PARTIAL }),
      ),
    ).toBeNull()
    expect(line(SIGNATURE_STATUS.ADDED, decision({ mode: 'Report' }))).toBeNull()
  })

  it('says nothing for a document HR signed in the editor, set aside, or with no decision', () => {
    // Added, but the last decision did not stamp everything: HR finished it by hand.
    expect(line(SIGNATURE_STATUS.ADDED, decision({ outcome: STAMP_OUTCOMES.PARTIAL }))).toBeNull()
    expect(line(SIGNATURE_STATUS.SKIPPED, decision())).toBeNull()
    expect(line(SIGNATURE_STATUS.NOT_REQUIRED, decision())).toBeNull()
    expect(line(SIGNATURE_STATUS.REVIEW_REQUIRED, null)).toBeNull()
  })
})
