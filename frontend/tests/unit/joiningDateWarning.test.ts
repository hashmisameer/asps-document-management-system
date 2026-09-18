import { describe, expect, it } from 'vitest'
import { ROLES, type Role } from '@asps-dms/shared'
import { joiningDateWarning } from '../../src/features/employees/joiningDateWarning.js'

/**
 * The warning under the joining date on the Add Employee form.
 *
 * The rule is the server's (judgeJoiningDate, tested with the backend); what
 * is tested here is when the form chooses to speak - not on a half-typed
 * date, not before sign-in has answered, and not about a date that is being
 * sent back unchanged.
 */

const TODAY = '2026-09-18'
type Who = { role: Role; joiningDateWindowDays: number }
const hr: Who = { role: ROLES.HR, joiningDateWindowDays: 7 }
const admin: Who = { role: ROLES.ADMIN, joiningDateWindowDays: 7 }

const warn = (value: string, user: Who = hr, existingJoiningDate: string | null = null) =>
  joiningDateWarning({ value, user, existingJoiningDate, today: TODAY })

describe('adding an employee', () => {
  it('says nothing about a date within the window', () => {
    expect(warn('2026-09-18')).toBeUndefined()
    expect(warn('2026-09-12')).toBeUndefined()
  })

  it('tells HR what to do about a date outside the window', () => {
    expect(warn('2026-09-11')).toBe(
      'This joining date is more than 7 days old. Only an administrator can add this employee.',
    )
  })

  it('lets an administrator use an old date, and stops a future one for everybody', () => {
    expect(warn('2026-09-11', admin)).toBeUndefined()
    expect(warn('2026-09-19', admin)).toBe('The joining date cannot be in the future.')
    expect(warn('2026-09-19', hr)).toBe('The joining date cannot be in the future.')
  })

  it('uses the window the server sent, not a number of its own', () => {
    expect(warn('2026-08-20', { role: ROLES.HR, joiningDateWindowDays: 30 })).toBeUndefined()
    expect(warn('2026-08-19', { role: ROLES.HR, joiningDateWindowDays: 30 })).toContain(
      'more than 30 days old',
    )
  })

  it('stays quiet while the date is still being typed', () => {
    expect(warn('')).toBeUndefined()
    expect(warn('2026-09')).toBeUndefined()
    expect(warn('2026-02-30')).toBeUndefined()
  })

  it('stays quiet before sign-in has answered', () => {
    expect(
      joiningDateWarning({
        value: '2020-01-01',
        user: null,
        existingJoiningDate: null,
        today: TODAY,
      }),
    ).toBeUndefined()
  })
})

describe('editing an employee', () => {
  it('says nothing about an old joining date that is not being changed', () => {
    expect(warn('2022-04-11', hr, '2022-04-11')).toBeUndefined()
  })

  it('applies the rule to a joining date that is being changed', () => {
    expect(warn('2022-04-12', hr, '2022-04-11')).toContain('Only an administrator')
    expect(warn('2022-04-12', admin, '2022-04-11')).toBeUndefined()
    expect(warn('2026-09-19', admin, '2022-04-11')).toBe(
      'The joining date cannot be in the future.',
    )
  })
})
