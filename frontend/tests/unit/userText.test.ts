import { describe, expect, it } from 'vitest'
import { ROLES, type UserListItem } from '@asps-dms/shared'
import {
  actionRefusal,
  filterCounts,
  filterUsers,
  roleDialogNote,
  signatureCell,
  statusCell,
} from '../../src/features/users/userText.js'

/**
 * The words in the Users table, and which actions a row offers.
 */

function user(overrides: Partial<UserListItem> = {}): UserListItem {
  return {
    userId: 7,
    username: 'hr1',
    fullName: 'Priya Sharma',
    role: ROLES.HR,
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: '2026-09-18T04:00:00.000Z',
    hasSignature: true,
    ...overrides,
  }
}

describe('the Status cell', () => {
  it('says Active, Inactive, or - as a fact, not a warning - that they have never signed in', () => {
    expect(statusCell(user())).toEqual({ text: 'Active', tone: 'active' })
    expect(statusCell(user({ isActive: false }))).toEqual({ text: 'Inactive', tone: 'inactive' })
    expect(statusCell(user({ mustChangePassword: true }))).toEqual({
      text: 'Has not signed in yet',
      tone: 'fact',
    })
  })

  it('calls an inactive account inactive even if it never signed in', () => {
    expect(statusCell(user({ isActive: false, mustChangePassword: true })).text).toBe('Inactive')
  })
})

describe('the Signature cell', () => {
  it('says on file, quietly', () => {
    expect(signatureCell(user())).toMatchObject({ text: 'on file', tone: 'quiet' })
  })

  it('makes none visible, and says why it matters', () => {
    const cell = signatureCell(user({ hasSignature: false }))
    expect(cell.text).toBe('none')
    expect(cell.tone).toBe('missing')
    expect(cell.hint).toContain('partly stamped')
  })

  it('says a Viewer does not need one - not applicable, not unknown', () => {
    const cell = signatureCell(user({ role: ROLES.VIEWER, hasSignature: false }))
    expect(cell.text).toBe('not needed')
    expect(cell.tone).toBe('quiet')
    expect(cell.hint).toContain('never signs anything')
  })
})

describe('the filter', () => {
  const users = [user({ userId: 1 }), user({ userId: 2, isActive: false }), user({ userId: 3 })]

  it('shows active by default, inactive on request, and everyone on request', () => {
    expect(filterUsers(users, 'active').map((u) => u.userId)).toEqual([1, 3])
    expect(filterUsers(users, 'inactive').map((u) => u.userId)).toEqual([2])
    expect(filterUsers(users, 'all')).toHaveLength(3)
    expect(filterCounts(users)).toEqual({ all: 3, active: 2, inactive: 1 })
  })
})

describe('which actions a row offers', () => {
  const me = { userId: 1 }
  const admin = (overrides: Partial<UserListItem> = {}) =>
    user({ userId: 1, role: ROLES.ADMIN, ...overrides })

  it('never lets you deactivate or demote yourself', () => {
    expect(actionRefusal('deactivate', admin(), me, 2)).toBe(
      'You cannot deactivate your own account.',
    )
    expect(actionRefusal('changeRole', admin(), me, 2)).toBe('You cannot change your own role.')
  })

  it('protects the last active administrator', () => {
    const other = admin({ userId: 2 })
    expect(actionRefusal('deactivate', other, me, 1)).toContain('last active administrator')
    expect(actionRefusal('changeRole', other, me, 1)).toContain('last active administrator')
    expect(actionRefusal('deactivate', other, me, 2)).toBeNull()
  })

  it('never blocks an HR user or a Viewer on the administrator count', () => {
    expect(actionRefusal('deactivate', user({ userId: 9 }), me, 1)).toBeNull()
    expect(actionRefusal('changeRole', user({ userId: 9, role: ROLES.VIEWER }), me, 1)).toBeNull()
  })

  it('does not protect an administrator who is already inactive', () => {
    expect(actionRefusal('changeRole', admin({ userId: 2, isActive: false }), me, 1)).toBeNull()
  })
})

describe('the role dialog', () => {
  it('says what making somebody an administrator also lets them do', () => {
    expect(roleDialogNote(7)).toBe(
      'An administrator can also add an employee with any past joining date; HR can only add someone who joined in the last 7 days.',
    )
    expect(roleDialogNote(30)).toContain('last 30 days')
  })
})
