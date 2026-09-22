import { describe, expect, it } from 'vitest'
import { STAMP_OUTCOMES } from '@asps-dms/shared'
import type { StampDecisionReportRow } from '../../src/repositories/stampDecision.repository.js'
import {
  formatDecision,
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
