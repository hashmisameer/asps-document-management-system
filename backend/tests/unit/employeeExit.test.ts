import { describe, expect, it } from 'vitest'
import {
  DEADLINE_STATE,
  DOCUMENT_STATUS,
  EMPLOYMENT_STATUSES,
  EXIT_REASONS,
  PERMISSIONS,
  ROLES,
  daysWorked,
  deriveDeadline,
  markEmployeeLeftSchema,
  roleHasPermission,
} from '@asps-dms/shared'

/**
 * Resignation and exit.
 *
 * What is pinned here is the behaviour that would be expensive to get wrong: an
 * employee who has left stops being chased, somebody still working their notice
 * does not, and neither the dates nor the permission can be got round.
 */

describe('the two exit dates', () => {
  it('rejects a last working date before the resignation', () => {
    // The ordering rule itself, as the service applies it. Both are ISO dates,
    // so comparing them as strings compares them as days.
    const resignationDate = '2026-09-10'
    const lastWorkingDate = '2026-09-01'
    expect(lastWorkingDate < resignationDate).toBe(true)
  })

  it('accepts a notice period, where the last day is a month later', () => {
    const parsed = markEmployeeLeftSchema.parse({
      resignationDate: '2026-09-01',
      lastWorkingDate: '2026-09-30',
      exitReason: EXIT_REASONS.RESIGNED,
    })
    expect(parsed.lastWorkingDate).toBe('2026-09-30')
    expect(parsed.exitNotes).toBeNull()
  })

  it('refuses a reason that is not one of the four', () => {
    expect(() =>
      markEmployeeLeftSchema.parse({
        resignationDate: '2026-09-01',
        lastWorkingDate: '2026-09-30',
        exitReason: 'SACKED',
      }),
    ).toThrow()
  })

  it('accepts an empty notes box, however the form spells empty', () => {
    // The dialog sends null for a box the person deliberately left blank. The
    // field was `.optional()`, which in zod accepts undefined and REFUSES null,
    // so leaving the optional note empty failed the whole request and marking
    // somebody as left only worked if you happened to type something.
    const base = {
      resignationDate: '2026-09-02',
      lastWorkingDate: '2026-09-02',
      exitReason: EXIT_REASONS.RESIGNED,
    }
    expect(markEmployeeLeftSchema.parse({ ...base, exitNotes: null }).exitNotes).toBeNull()
    expect(markEmployeeLeftSchema.parse({ ...base, exitNotes: '' }).exitNotes).toBeNull()
    expect(markEmployeeLeftSchema.parse(base).exitNotes).toBeNull()
    expect(markEmployeeLeftSchema.parse({ ...base, exitNotes: 'Moved firms' }).exitNotes).toBe(
      'Moved firms',
    )
  })

  it('requires both dates', () => {
    expect(() =>
      markEmployeeLeftSchema.parse({
        resignationDate: '2026-09-01',
        exitReason: EXIT_REASONS.RESIGNED,
      }),
    ).toThrow()
  })
})

describe('a document belonging to someone who has left', () => {
  const dueDate = '2026-01-01'
  const today = '2026-09-02'

  it('is overdue while they still work here', () => {
    const deadline = deriveDeadline(dueDate, DOCUMENT_STATUS.PENDING, { today })
    expect(deadline.state).toBe(DEADLINE_STATE.OVERDUE)
  })

  it('stops being overdue once they have gone', () => {
    // The document is still missing and still Pending. It has simply stopped
    // being late, because there is nobody left for it to be late from - which
    // is what kept a leaver's PF form reading 'Overdue by 200 days' in reports.
    const deadline = deriveDeadline(dueDate, DOCUMENT_STATUS.PENDING, {
      today,
      employeeHasLeft: true,
    })
    expect(deadline.state).toBe(DEADLINE_STATE.NOT_APPLICABLE)
    expect(deadline.daysRemaining).toBeNull()
    expect(deadline.label).toContain('has left')
  })

  it('does not pretend the document arrived', () => {
    const deadline = deriveDeadline(dueDate, DOCUMENT_STATUS.PENDING, {
      today,
      employeeHasLeft: true,
    })
    expect(deadline.state).not.toBe(DEADLINE_STATE.COMPLETED)
  })
})

describe('who may record an exit', () => {
  it('lets HR do it', () => {
    expect(roleHasPermission(ROLES.HR, PERMISSIONS.EMPLOYEE_EXIT)).toBe(true)
  })

  it('lets an administrator do it', () => {
    expect(roleHasPermission(ROLES.ADMIN, PERMISSIONS.EMPLOYEE_EXIT)).toBe(true)
  })

  it('does not let a viewer do it', () => {
    expect(roleHasPermission(ROLES.VIEWER, PERMISSIONS.EMPLOYEE_EXIT)).toBe(false)
  })

  it('is a separate permission from archiving', () => {
    // Leaving the company and the office being finished with the record are
    // different decisions, and a role could reasonably hold one without the
    // other.
    expect(PERMISSIONS.EMPLOYEE_EXIT).not.toBe(PERMISSIONS.EMPLOYEE_ARCHIVE)
  })
})

describe('days worked', () => {
  it('counts the first day and the last', () => {
    // 1 August to 30 September inclusive.
    expect(daysWorked('2026-08-01', '2026-09-30')).toBe(61)
  })

  it('counts a single day as one, not none', () => {
    expect(daysWorked('2026-08-01', '2026-08-01')).toBe(1)
  })

  it('returns null when the dates are the wrong way round', () => {
    expect(daysWorked('2026-09-30', '2026-08-01')).toBeNull()
  })
})

describe('employment status is not the archive flag', () => {
  it('has its own two values', () => {
    expect(EMPLOYMENT_STATUSES.ACTIVE).toBe('ACTIVE')
    expect(EMPLOYMENT_STATUSES.LEFT).toBe('LEFT')
  })
})
