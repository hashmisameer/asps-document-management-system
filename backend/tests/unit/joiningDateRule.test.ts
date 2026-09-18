import { describe, expect, it } from 'vitest'
import { ROLES, judgeJoiningDate } from '@asps-dms/shared'

/**
 * Who may add an employee, by joining date.
 *
 * The office's example, verbatim: today is 18 September and the window is 7,
 * so HR may use 12 to 18 September and 11 September is refused. Every case
 * below is pinned to that day, because a rule about 'today' tested against the
 * real clock passes on the day it is written and fails a week later.
 */

const TODAY = '2026-09-18'
const rule = (joiningDate: string, role: 'HR' | 'ADMIN' | 'VIEWER', windowDays = 7) =>
  judgeJoiningDate({ joiningDate, role: ROLES[role], today: TODAY, windowDays })

describe('HR, with a window of 7', () => {
  it('may use today', () => {
    expect(rule('2026-09-18', 'HR')).toEqual({ allowed: true })
  })

  it('may use the earliest of the seven dates, 12 September', () => {
    expect(rule('2026-09-12', 'HR')).toEqual({ allowed: true })
  })

  it('is refused 11 September, the day before the window', () => {
    const verdict = rule('2026-09-11', 'HR')

    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toBe('too-old')
    expect(verdict.message).toBe(
      'This joining date is more than 7 days old. Only an administrator can add this employee.',
    )
  })

  it('is refused anything older', () => {
    expect(rule('2026-04-01', 'HR').reason).toBe('too-old')
    expect(rule('2022-04-11', 'HR').reason).toBe('too-old')
  })

  it('counts calendar dates, so a month end is nothing special', () => {
    expect(
      judgeJoiningDate({
        joiningDate: '2026-08-26',
        role: ROLES.HR,
        today: '2026-09-01',
        windowDays: 7,
      }),
    ).toEqual({ allowed: true })
    expect(
      judgeJoiningDate({
        joiningDate: '2026-08-25',
        role: ROLES.HR,
        today: '2026-09-01',
        windowDays: 7,
      }).reason,
    ).toBe('too-old')
  })
})

describe('an administrator', () => {
  it('may use any date that has arrived', () => {
    expect(rule('2026-09-18', 'ADMIN')).toEqual({ allowed: true })
    expect(rule('2026-09-11', 'ADMIN')).toEqual({ allowed: true })
    expect(rule('2022-04-11', 'ADMIN')).toEqual({ allowed: true })
  })
})

describe('a joining date in the future', () => {
  it('is refused for everybody, with its own message', () => {
    for (const role of ['HR', 'ADMIN', 'VIEWER'] as const) {
      const verdict = rule('2026-09-19', role)

      expect(verdict.allowed).toBe(false)
      expect(verdict.reason).toBe('future')
      expect(verdict.message).toBe('The joining date cannot be in the future.')
    }
  })
})

describe('the window is a setting', () => {
  it('admits exactly as many dates as it is told, today included', () => {
    expect(rule('2026-09-18', 'HR', 1)).toEqual({ allowed: true })
    expect(rule('2026-09-17', 'HR', 1).reason).toBe('too-old')

    expect(rule('2026-08-20', 'HR', 30)).toEqual({ allowed: true })
    expect(rule('2026-08-19', 'HR', 30).reason).toBe('too-old')
  })

  it('names the number it was given in the message', () => {
    expect(rule('2026-08-01', 'HR', 30).message).toContain('more than 30 days old')
  })
})
