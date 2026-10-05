import { describe, expect, it } from 'vitest'
import type { DeadlineCandidate } from '../../src/repositories/employeeDocument.repository.js'
import { planMoves } from '../../src/services/deadlineRecompute.service.js'

/**
 * Which deadlines are out of step with their joining date.
 *
 * Pure: candidates in, moves out. What is asserted here is the arithmetic and
 * the judgement - a date already right is not a move, days and months are both
 * understood, and a row with nothing to compute from is left alone. Which ROWS
 * are offered up at all (no file, type has a deadline) is the repository's
 * query, proved against the database in the integration suite.
 */

function candidate(overrides: Partial<DeadlineCandidate> = {}): DeadlineCandidate {
  return {
    documentId: 501,
    employeeId: 42,
    employeeCode: '00006135',
    documentCode: 'PF_FORM',
    documentName: 'PF Form / Form 11',
    dueDate: '1988-09-14',
    joiningDate: '2026-09-01',
    deadlineValue: 12,
    deadlineUnit: 'DAY',
    wasOverridden: false,
    ...overrides,
  }
}

describe('planMoves', () => {
  it('moves a deadline that disagrees with the joining date', () => {
    // The case this exists for: a date of birth was typed into the joining
    // date, corrected later, and the deadline stayed in 1988.
    expect(planMoves([candidate()])).toEqual([
      {
        documentId: 501,
        employeeId: 42,
        employeeCode: '00006135',
        documentName: 'PF Form / Form 11',
        from: '1988-09-14',
        to: '2026-09-13',
        wasOverridden: false,
      },
    ])
  })

  it('leaves a deadline that is already right - so running it twice moves nothing', () => {
    expect(planMoves([candidate({ dueDate: '2026-09-13' })])).toEqual([])
  })

  it('counts months as months, not as thirty days', () => {
    const [move] = planMoves([
      candidate({
        documentCode: 'CONFIRMATION_LETTER',
        documentName: 'Confirmation Letter',
        deadlineValue: 6,
        deadlineUnit: 'MONTH',
        dueDate: null,
      }),
    ])
    expect(move?.to).toBe('2027-03-01')
    expect(move?.from).toBeNull()
  })

  it('fills in a deadline that was never set', () => {
    const [move] = planMoves([candidate({ dueDate: null })])
    expect(move).toMatchObject({ from: null, to: '2026-09-13' })
  })

  it('moves a deadline EARLIER as readily as later', () => {
    // A joining date corrected backwards: the deadline has to come back with
    // it, or the document stops being chased when it should be.
    const [move] = planMoves([candidate({ dueDate: '2030-01-01' })])
    expect(move?.to).toBe('2026-09-13')
  })

  it('carries whether a person had set that deadline by hand', () => {
    // The recompute overwrites it, and saying so is how an override that is
    // about to disappear is seen rather than lost.
    expect(planMoves([candidate({ wasOverridden: true })])[0]?.wasOverridden).toBe(true)
  })

  it('keeps every employee’s rows, not just the first', () => {
    const moves = planMoves([
      candidate({ documentId: 1, employeeId: 1, employeeCode: '00006135' }),
      candidate({ documentId: 2, employeeId: 2, employeeCode: '00006137' }),
      candidate({ documentId: 3, employeeId: 2, employeeCode: '00006137', dueDate: '2026-09-13' }),
    ])
    expect(moves.map((move) => move.documentId)).toEqual([1, 2])
  })

  it('is empty for nothing at all', () => {
    expect(planMoves([])).toEqual([])
  })
})
