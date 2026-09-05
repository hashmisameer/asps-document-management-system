import { describe, expect, it } from 'vitest'
import { MAX_SELF_REGISTRATIONS, registerSchema } from '@asps-dms/shared'

/**
 * What the registration form will and will not accept.
 *
 * The cap itself is enforced in SQL and cannot be tested without a database, so
 * what is pinned here is the other half: the shape of a registration, and the
 * one thing it must never be able to ask for.
 */

function valid(overrides: Record<string, unknown> = {}) {
  return {
    username: 'r.sharma',
    fullName: 'Radhika Sharma',
    role: 'HR',
    // asps-dms:allow-secret - a fixture password for a schema test.
    password: 'GoodPassword2026',
    confirmPassword: 'GoodPassword2026',
    ...overrides,
  }
}

describe('registerSchema', () => {
  it('accepts an ordinary registration', () => {
    expect(registerSchema.safeParse(valid()).success).toBe(true)
  })

  it('REFUSES a request asking for ADMIN', () => {
    // The one that matters. A form anyone on the network can reach must not be
    // able to mint the role that manages every other account.
    const result = registerSchema.safeParse(valid({ role: 'ADMIN' }))
    expect(result.success).toBe(false)
  })

  it('defaults to HR when no role is given', () => {
    const parsed = registerSchema.parse({
      username: 'r.sharma',
      fullName: 'Radhika Sharma',
      // asps-dms:allow-secret - a fixture password for a schema test.
      password: 'GoodPassword2026',
      confirmPassword: 'GoodPassword2026',
    })
    expect(parsed.role).toBe('HR')
  })

  it('requires the two passwords to match', () => {
    const result = registerSchema.safeParse(valid({ confirmPassword: 'SomethingElse2026' }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'confirmPassword')).toBe(true)
    }
  })

  it('holds a registration to the same password policy as everything else', () => {
    // asps-dms:allow-secret - deliberately bad fixture passwords.
    expect(registerSchema.safeParse(valid({ password: 'short1A', confirmPassword: 'short1A' })).success).toBe(false)
    expect(
      // asps-dms:allow-secret - deliberately bad fixture password.
      registerSchema.safeParse(valid({ password: 'alllowercase2026', confirmPassword: 'alllowercase2026' }))
        .success,
    ).toBe(false)
  })

  it('lower-cases the username, so Ravi and ravi cannot both be taken', () => {
    const parsed = registerSchema.parse(valid({ username: 'R.Sharma' }))
    expect(parsed.username).toBe('r.sharma')
  })

  it('refuses a username with a space or a symbol in it', () => {
    expect(registerSchema.safeParse(valid({ username: 'radhika sharma' })).success).toBe(false)
    expect(registerSchema.safeParse(valid({ username: 'radhika@asps' })).success).toBe(false)
    expect(registerSchema.safeParse(valid({ username: 'ab' })).success).toBe(false)
  })
})

describe('MAX_SELF_REGISTRATIONS', () => {
  it('is five, the size of the office', () => {
    // Pinned because it is the whole feature. Changing it should be a decision,
    // not a stray edit.
    expect(MAX_SELF_REGISTRATIONS).toBe(5)
  })
})
