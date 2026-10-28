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

  it('says check template when a box that should be empty was occupied', () => {
    // The configuration mistake that is otherwise silent: a box drawn over
    // something printed on the form, reading as 'Not stamped'.
    const suspect = decision({
      outcome: STAMP_OUTCOMES.PARTIAL,
      boxes: [
        { signerRole: 'Authoriser', pageNumber: 1, action: 'stamp', reason: null, found: 'empty' },
        {
          signerRole: 'Employee',
          pageNumber: 1,
          action: 'skip',
          reason: 'the box should be empty and already has something in it (an image covers 33% of the box) - check the template box is in the right place',
          found: 'occupied',
          checkTemplate: true,
        },
      ],
    })
    expect(line(SIGNATURE_STATUS.REVIEW_REQUIRED, suspect)).toBe('Check template')
    expect(line(SIGNATURE_STATUS.REVIEW_REQUIRED, { ...suspect, outcome: STAMP_OUTCOMES.NOTHING })).toBe(
      'Check template',
    )
  })

  it('says nothing about the template once the document has been signed', () => {
    const suspect = decision({
      outcome: STAMP_OUTCOMES.PARTIAL,
      boxes: [
        {
          signerRole: 'Employee',
          pageNumber: 1,
          action: 'skip',
          reason: 'x',
          found: 'occupied',
          checkTemplate: true,
        },
      ],
    })
    expect(line(SIGNATURE_STATUS.ADDED, suspect)).toBeNull()
    expect(line(SIGNATURE_STATUS.REVIEW_REQUIRED, { ...suspect, mode: 'Report' })).toBeNull()
  })

  it('says stamped automatically for a document finished with a box MMC filled', () => {
    const finished = decision({
      boxes: [
        { signerRole: 'Employee', pageNumber: 1, action: 'stamp', reason: null, found: 'empty' },
        {
          signerRole: 'Authoriser',
          pageNumber: 1,
          action: 'filled',
          reason: 'the box already has something in it, as the template expects (an image covers 54% of the box)',
          found: 'occupied',
        },
      ],
    })
    expect(line(SIGNATURE_STATUS.ADDED, finished)).toBe('Stamped automatically')
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

  it('says nothing for a type not in the auto-stamp list - it was never a candidate', () => {
    const notInList = decision({
      outcome: STAMP_OUTCOMES.NOT_IN_LIST,
      summary: 'Not stamped: PF Form is not in the auto-stamp list.',
      stampedCount: 0,
    })
    expect(line(SIGNATURE_STATUS.REVIEW_REQUIRED, notInList)).toBeNull()
    expect(line(SIGNATURE_STATUS.ADDED, notInList)).toBeNull()
  })
})
