import { describe, expect, it } from 'vitest'
import { STAMP_OUTCOMES } from '@asps-dms/shared'
import type { StampDecisionReportRow } from '../../src/repositories/stampDecision.repository.js'
import {
  formatDecision,
  formatRedecide,
  formatSummary,
  parseSince,
  summarise,
} from '../../src/services/autoStampReport.service.js'

/**
 * The trial report: what it counts, what it prints, and what it never prints.
 *
 * The office reads this for a few days before stamping is switched on, so the
 * counts at the top have to be right and the lines below have to say why
 * each box was left alone - and none of it may name an employee.
 */

function row(overrides: Partial<StampDecisionReportRow> = {}): StampDecisionReportRow {
  return {
    stampDecisionId: 1,
    documentId: 501,
    documentCode: 'APPOINTMENT_LETTER',
    documentName: 'Appointment Letter',
    mode: 'Report',
    outcome: STAMP_OUTCOMES.PARTIAL,
    variantKey: '1p-595x842',
    stampedCount: 1,
    skippedCount: 1,
    summary:
      'Stamped: employee signature. Not stamped: the hr signature - the person who uploaded it has no signature on file.',
    boxes: [
      { signerRole: 'Employee', pageNumber: 1, action: 'stamp', reason: null, found: 'empty' },
      {
        signerRole: 'Authoriser',
        pageNumber: 1,
        action: 'skip',
        reason: 'the person who uploaded it has no signature on file',
        found: 'empty',
      },
    ],
    decidedBy: 7,
    decidedAt: '2026-09-18T04:11:00.000Z',
    ...overrides,
  }
}

describe('parseSince', () => {
  const now = new Date('2026-09-18T12:00:00.000Z')

  it('reads days, hours and minutes back from now', () => {
    expect(parseSince('7d', now)?.toISOString()).toBe('2026-09-11T12:00:00.000Z')
    expect(parseSince('24h', now)?.toISOString()).toBe('2026-09-17T12:00:00.000Z')
    expect(parseSince('30m', now)?.toISOString()).toBe('2026-09-18T11:30:00.000Z')
  })

  it('reads a date as the start of that day', () => {
    const at = parseSince('2026-09-10', now)
    expect(at?.getFullYear()).toBe(2026)
    expect(at?.getMonth()).toBe(8)
    expect(at?.getDate()).toBe(10)
    expect(at?.getHours()).toBe(0)
  })

  it('refuses anything else rather than guessing', () => {
    expect(parseSince('yesterday', now)).toBeNull()
    expect(parseSince('7', now)).toBeNull()
    expect(parseSince('2026-13-45', now)).toBeNull()
  })
})

describe('formatDecision', () => {
  it('prints the document, the decision and every box with its reason', () => {
    const lines = formatDecision(row())

    expect(lines[0]).toContain('#501  Appointment Letter')
    expect(lines[0]).toContain('report  Partly stamped  1p-595x842')
    expect(lines[1]).toBe(
      '    Stamped: employee signature. Not stamped: the hr signature - the person who uploaded it has no signature on file.',
    )
    expect(lines[2]).toBe('    - employee p1: stamp, found empty')
    expect(lines[3]).toBe(
      '    - authoriser p1: skip, found empty - the person who uploaded it has no signature on file',
    )
  })

  it('prints a kept box as kept, and does not count it as left alone', () => {
    const kept = row({
      outcome: STAMP_OUTCOMES.STAMPED,
      stampedCount: 2,
      skippedCount: 0,
      summary:
        'Stamped: employee signature and hr signature. Kept: employee photo (placed by hand).',
      boxes: [
        {
          signerRole: 'Photo',
          pageNumber: 1,
          action: 'keep',
          reason: 'already on the page, placed by hand',
          found: null,
        },
        { signerRole: 'Employee', pageNumber: 1, action: 'stamp', reason: null, found: 'empty' },
        { signerRole: 'Authoriser', pageNumber: 1, action: 'stamp', reason: null, found: 'empty' },
      ],
    })
    const lines = formatDecision(kept)
    expect(lines[2]).toBe('    - photo p1: keep - already on the page, placed by hand')
    const summary = summarise([kept])
    expect(summary.boxesLeftAlone).toBe(0)
    expect(summary.reasons).toEqual([])
  })

  it('names no employee', () => {
    // The row type carries none, so this pins the line against ever growing one.
    const text = formatDecision(row()).join('\n')
    expect(text).not.toMatch(/EMP|Ravi|Kumar|employeeCode|employeeName/)
  })

  it('leaves out the variant when there was none', () => {
    const lines = formatDecision(
      row({ outcome: STAMP_OUTCOMES.NOT_PDF, variantKey: null, boxes: [], stampedCount: 0 }),
    )
    expect(lines[0]).toMatch(/report {2}Not a PDF$/)
    expect(lines).toHaveLength(2)
  })
})

describe('summarise', () => {
  const rows = [
    row(),
    row({
      documentId: 502,
      outcome: STAMP_OUTCOMES.STAMPED,
      stampedCount: 2,
      skippedCount: 0,
      boxes: [],
    }),
    row({
      documentId: 503,
      outcome: STAMP_OUTCOMES.NOTHING,
      stampedCount: 0,
      skippedCount: 2,
      boxes: [
        {
          signerRole: 'Employee',
          pageNumber: 1,
          action: 'skip',
          reason: 'the employee has no signature on file',
          found: 'empty',
        },
        {
          signerRole: 'Authoriser',
          pageNumber: 1,
          action: 'skip',
          reason: 'the person who uploaded it has no signature on file',
          found: 'empty',
        },
      ],
    }),
    row({
      documentId: 504,
      mode: 'Stamp',
      outcome: STAMP_OUTCOMES.NOT_PDF,
      variantKey: null,
      boxes: [],
      stampedCount: 0,
      skippedCount: 0,
    }),
  ]

  it('counts decisions, modes, boxes and outcomes', () => {
    const summary = summarise(rows)

    expect(summary.decisions).toBe(4)
    expect(summary.reportMode).toBe(3)
    expect(summary.stampMode).toBe(1)
    expect(summary.boxesStamped).toBe(3)
    expect(summary.boxesLeftAlone).toBe(3)
    expect(summary.byOutcome).toEqual({ Partial: 1, Stamped: 1, Nothing: 1, NotPdf: 1 })
  })

  it('lists the reasons boxes were left alone, most common first', () => {
    const summary = summarise(rows)

    expect(summary.reasons).toEqual([
      { reason: 'the person who uploaded it has no signature on file', count: 2 },
      { reason: 'Not a PDF', count: 1 },
      { reason: 'the employee has no signature on file', count: 1 },
    ])
  })

  it('prints the summary in that order', () => {
    const lines = formatSummary(summarise(rows))

    expect(lines[0]).toBe('4 decision(s): 3 recorded only, 1 stamped')
    expect(lines[1]).toBe('boxes: 3 stamped (or would be), 3 left alone')
    expect(lines).toContain('      2  the person who uploaded it has no signature on file')
  })

  it('is empty-safe', () => {
    expect(summarise([]).decisions).toBe(0)
    expect(formatSummary(summarise([]))[0]).toBe('0 decision(s): 0 recorded only, 0 stamped')
  })

  it('counts a type not in the auto-stamp list apart, and never as a reason a box was left alone', () => {
    const notInList = row({
      documentId: 502,
      documentCode: 'PF_FORM',
      documentName: 'PF Form',
      outcome: STAMP_OUTCOMES.NOT_IN_LIST,
      variantKey: null,
      stampedCount: 0,
      skippedCount: 0,
      boxes: [],
      summary: 'Not stamped: PF Form is not in the auto-stamp list.',
    })
    const summary = summarise([...rows, notInList, { ...notInList, documentId: 503 }])

    expect(summary.decisions).toBe(6)
    expect(summary.notInList).toBe(2)
    expect(summary.byOutcome[STAMP_OUTCOMES.NOT_IN_LIST]).toBe(2)
    expect(summary.reasons.map((r) => r.reason)).not.toContain('Not in the auto-stamp list')
    // The counts of what was stamped and left alone are unchanged by them.
    expect(summary.boxesStamped).toBe(3)
    expect(summary.boxesLeftAlone).toBe(3)

    const lines = formatSummary(summary)
    expect(lines[0]).toBe(
      '6 decision(s): 3 recorded only, 1 stamped, 2 not in the auto-stamp list (left for HR on purpose)',
    )
    expect(lines).toContain('      2  Not in the auto-stamp list')
  })
})

/**
 * Boxes MMC fills, and boxes that should be empty and are not.
 *
 * The first are counted apart from both 'stamped' and 'left alone', with what
 * was measured in them; the documents finished with one are listed for a
 * spot-check. The second are each listed, first, because every one is a box
 * somebody has to go and move.
 */
describe('filled boxes and boxes to check the template for', () => {
  const form2 = row({
    documentId: 610,
    documentCode: 'PF_FORM',
    documentName: 'PF Form',
    mode: 'Stamp',
    outcome: STAMP_OUTCOMES.STAMPED,
    stampedCount: 2,
    skippedCount: 0,
    boxes: [
      { signerRole: 'Employee', pageNumber: 1, action: 'stamp', reason: null, found: 'empty' },
      { signerRole: 'Employee', pageNumber: 2, action: 'stamp', reason: null, found: 'empty' },
      {
        signerRole: 'Authoriser',
        pageNumber: 2,
        action: 'filled',
        reason: 'the box already has something in it, as the template expects (an image covers 54% of the box)',
        found: 'occupied',
      },
    ],
  })
  const misplaced = row({
    documentId: 611,
    documentCode: 'PF_FORM',
    documentName: 'PF Form',
    mode: 'Stamp',
    outcome: STAMP_OUTCOMES.NOTHING,
    stampedCount: 0,
    skippedCount: 1,
    boxes: [
      {
        signerRole: 'Employee',
        pageNumber: 1,
        action: 'skip',
        reason:
          'the box should be empty and already has something in it (an image covers 33% of the box) - check the template box is in the right place',
        found: 'occupied',
        checkTemplate: true,
      },
    ],
  })

  it('counts filled boxes apart, and lists the documents finished with one', () => {
    const summary = summarise([form2, misplaced])

    expect(summary.boxesStamped).toBe(2)
    expect(summary.boxesFilled).toBe(1)
    expect(summary.boxesLeftAlone).toBe(1)
    expect(summary.filledBecause).toEqual([
      {
        reason:
          'the box already has something in it, as the template expects (an image covers 54% of the box)',
        count: 1,
      },
    ])
    expect(summary.finishedWithFilled).toEqual([610])
  })

  it('lists every box to check the template for, before the reasons', () => {
    const lines = formatSummary(summarise([form2, misplaced]))

    expect(lines[1]).toBe('boxes: 2 stamped (or would be), 1 already filled, 1 left alone')
    const check = lines.indexOf(
      'CHECK THE TEMPLATE - 1 box(es) that should be empty were occupied:',
    )
    expect(check).toBeGreaterThan(0)
    expect(lines[check + 1]).toBe(
      '  #611  PF Form  employee signature p1 - the box should be empty and already has something in it (an image covers 33% of the box) - check the template box is in the right place',
    )
    expect(check).toBeLessThan(lines.indexOf('left alone because:'))
    expect(lines).toContain('taken as already filled because:')
    expect(lines).toContain('finished with a box taken as filled - spot-check these: 1')
    expect(lines).toContain('  #610')
  })

  it('shows twenty document ids to spot-check and says how many more', () => {
    const many = Array.from({ length: 23 }, (_, index) => ({ ...form2, documentId: 700 + index }))
    const lines = formatSummary(summarise(many))
    const ids = lines[lines.indexOf('finished with a box taken as filled - spot-check these: 23') + 1]
    expect(ids?.match(/#\d+/g)).toHaveLength(20)
    expect(ids).toMatch(/#719 and 3 more$/)
  })

  it('says nothing about either when there is none', () => {
    const lines = formatSummary(summarise([row()]))
    expect(lines.join('\n')).not.toContain('CHECK THE TEMPLATE')
    expect(lines.join('\n')).not.toContain('spot-check')
  })
})

describe('formatRedecide', () => {
  const box = (
    signerRole: 'Employee' | 'Authoriser',
    pageNumber: number,
    action: 'stamp' | 'keep' | 'filled' | 'skip',
    reason: string | null,
  ) => ({ signerRole, pageNumber, action, reason, found: null })

  it('says a PF form stamped earlier would become Added, nothing painted', () => {
    const line = formatRedecide(
      {
        documentId: 610,
        documentName: 'PF Form',
        kind: 'preview',
        decision: {
          outcome: STAMP_OUTCOMES.STAMPED,
          nextStatus: 'Added',
          boxes: [
            box('Employee', 1, 'keep', 'already stamped earlier'),
            box('Employee', 2, 'keep', 'already stamped earlier'),
            box('Authoriser', 2, 'filled', 'as the template expects (an image covers 54% of the box)'),
          ],
        } as never,
      },
      'Added',
    )

    expect(line).toBe(
      '#610  PF Form  keep: employee signature p1 (already stamped earlier), ' +
        'employee signature p2 (already stamped earlier); ' +
        'already filled: hr signature p2 (as the template expects (an image covers 54% of the box))' +
        '  -> would become Added (nothing painted)',
    )
  })

  it('says what a real run did, and where the document landed', () => {
    const line = formatRedecide({
      documentId: 7,
      documentName: 'ESIC Form',
      kind: 'decided',
      result: {
        documentId: 7,
        mode: 'Stamp',
        stamped: 1,
        status: 'Added',
        decision: {
          outcome: STAMP_OUTCOMES.STAMPED,
          boxes: [box('Employee', 1, 'stamp', null)],
        } as never,
      },
    })
    expect(line).toBe('#7  ESIC Form  added: employee signature p1  -> Added')
  })

  it('says a document left alone, and why', () => {
    expect(
      formatRedecide({
        documentId: 8,
        documentName: 'PF Form',
        kind: 'left',
        reason: 'signerUnavailable',
        detail: 'the hr signature on it was placed by Gone HR, whose account is no longer active',
      }),
    ).toBe(
      '#8  PF Form  left alone: the hr signature on it was placed by Gone HR, whose account is no longer active',
    )
  })
})
