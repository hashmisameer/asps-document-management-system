import { describe, expect, it } from 'vitest'
import { SIGNATURE_STATUS, STAMP_OUTCOMES, type StampDecisionSummary } from '@asps-dms/shared'
import { describeStampDecision, signLabel } from '../../src/features/documents/stampDecisionText.js'

/**
 * The line beside the Sign button: when it speaks, and what it says.
 *
 * It speaks only while HR still has something to do. A document stamped whole
 * is said by the tick on the button; one that needs no signature says nothing.
 */

function decision(overrides: Partial<StampDecisionSummary> = {}): StampDecisionSummary {
  return {
    mode: 'Stamp',
    outcome: STAMP_OUTCOMES.PARTIAL,
    summary:
      'Stamped: employee signature. Not stamped: the hr signature - the person who uploaded it has no signature on file.',
    stampedCount: 1,
    skippedCount: 1,
    boxes: [],
    decidedAt: '2026-09-18T04:11:00.000Z',
    ...overrides,
  }
}

describe('describeStampDecision', () => {
  it('says nothing for a document with no decision', () => {
    expect(
      describeStampDecision({
        signatureStatus: SIGNATURE_STATUS.REVIEW_REQUIRED,
        stampDecision: null,
      }),
    ).toBeNull()
  })

  it('says nothing once the document is signed or set aside', () => {
    for (const signatureStatus of [
      SIGNATURE_STATUS.ADDED,
      SIGNATURE_STATUS.SKIPPED,
      SIGNATURE_STATUS.NOT_REQUIRED,
    ]) {
      expect(describeStampDecision({ signatureStatus, stampDecision: decision() })).toBeNull()
    }
  })

  it('says a partly stamped document is partly stamped, in the server’s words', () => {
    const line = describeStampDecision({
      signatureStatus: SIGNATURE_STATUS.REVIEW_REQUIRED,
      stampDecision: decision(),
    })

    expect(line?.heading).toBe('Partly stamped automatically')
    expect(line?.detail).toBe(decision().summary)
    expect(line?.reportOnly).toBe(false)
  })

  it('says a document nothing went on is not stamped', () => {
    const line = describeStampDecision({
      signatureStatus: SIGNATURE_STATUS.REVIEW_REQUIRED,
      stampDecision: decision({
        outcome: STAMP_OUTCOMES.NO_VARIANT,
        summary: 'Not stamped: the file matches none of the template’s forms.',
        stampedCount: 0,
      }),
    })

    expect(line?.heading).toBe('Not stamped automatically')
    expect(line?.detail).toBe('Not stamped: the file matches none of the template’s forms.')
  })

  it('says in report mode that nothing was stamped, whatever was decided', () => {
    const line = describeStampDecision({
      signatureStatus: SIGNATURE_STATUS.REVIEW_REQUIRED,
      stampDecision: decision({
        mode: 'Report',
        outcome: STAMP_OUTCOMES.STAMPED,
        summary: 'Stamped: employee signature and hr signature.',
      }),
    })

    expect(line?.heading).toBe('Not stamped automatically')
    expect(line?.reportOnly).toBe(true)
    expect(line?.detail).toBe(
      'Stamping on upload is in report mode, so nothing was stamped. It would have decided: Stamped: employee signature and hr signature.',
    )
  })
})

describe('signLabel', () => {
  it('folds the heading into the button’s tooltip', () => {
    const line = describeStampDecision({
      signatureStatus: SIGNATURE_STATUS.REVIEW_REQUIRED,
      stampDecision: decision(),
    })
    expect(signLabel('Sign', line)).toBe('Sign - partly stamped automatically')
    expect(signLabel('Sign', null)).toBe('Sign')
  })
})
