import { describe, expect, it } from 'vitest'
import { describeUser } from '../../src/database/userText.js'
import type { UserListing } from '../../src/repositories/user.repository.js'

/**
 * A line of `npm run user:list`.
 *
 * The notes are what an administrator acts on - a disabled account, one still
 * owing a password change, one that has never been used - so what they say,
 * and when they are absent, is pinned here.
 */

function user(overrides: Partial<UserListing> = {}): UserListing {
  return {
    userId: 1,
    username: 'rakesh',
    fullName: 'Rakesh Sharma',
    role: 'HR',
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: new Date('2026-09-01T04:00:00.000Z'),
    hasSignature: true,
    ...overrides,
  }
}

describe('describeUser', () => {
  it('prints username, role and name, and nothing else for an account in good standing', () => {
    expect(describeUser(user())).toBe('rakesh               HR      Rakesh Sharma')
  })

  it('notes what needs attention, in a fixed order', () => {
    expect(
      describeUser(user({ isActive: false, mustChangePassword: true, lastLoginAt: null })),
    ).toBe('rakesh               HR      Rakesh Sharma  (disabled, must change password, never signed in)')
    expect(describeUser(user({ lastLoginAt: null }))).toBe(
      'rakesh               HR      Rakesh Sharma  (never signed in)',
    )
  })

  it('prints a role it does not recognise rather than hiding the account', () => {
    expect(describeUser(user({ role: 'AUDITOR' }))).toContain(' AUDITOR ')
  })
})
