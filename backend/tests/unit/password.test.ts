import { describe, expect, it } from 'vitest'
import { SCRYPT_ALGORITHM_ID } from '../../src/config/security.js'
import {
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../../src/services/password.service.js'

describe('password hashing', () => {
  it('accepts the correct password and rejects a wrong one', async () => {
    const record = await hashPassword('Correct-Horse-Battery-1')

    await expect(verifyPassword('Correct-Horse-Battery-1', record)).resolves.toBe(true)
    await expect(verifyPassword('Correct-Horse-Battery-2', record)).resolves.toBe(false)
    await expect(verifyPassword('', record)).resolves.toBe(false)
  })

  it('salts every hash, so identical passwords do not share a hash', async () => {
    const first = await hashPassword('Correct-Horse-Battery-1')
    const second = await hashPassword('Correct-Horse-Battery-1')

    expect(first.salt.equals(second.salt)).toBe(false)
    expect(first.hash.equals(second.hash)).toBe(false)
    // Both still verify: the salt is stored alongside, not derived from, the hash.
    await expect(verifyPassword('Correct-Horse-Battery-1', second)).resolves.toBe(true)
  })

  it('records the parameters it used, so the cost can be raised later', async () => {
    const record = await hashPassword('Correct-Horse-Battery-1')

    expect(record.algorithm).toBe(SCRYPT_ALGORITHM_ID)
    expect(record.algorithm).toMatch(/^scrypt\$\d+\$\d+\$\d+$/)
    // Fits dbo.Users.PasswordAlgorithm VARCHAR(30) and PasswordSalt VARBINARY(64).
    expect(record.algorithm.length).toBeLessThanOrEqual(30)
    expect(record.salt.length).toBeLessThanOrEqual(64)
    expect(record.hash.length).toBeLessThanOrEqual(256)
  })

  it('fails closed on a record it cannot interpret', async () => {
    const record = await hashPassword('Correct-Horse-Battery-1')

    for (const algorithm of ['', 'md5', 'scrypt', 'scrypt$0$0$0', 'argon2$3$65536$4']) {
      await expect(verifyPassword('Correct-Horse-Battery-1', { ...record, algorithm })).resolves.toBe(
        false,
      )
    }
  })

  it('flags a hash weaker than current policy for upgrade', () => {
    expect(needsRehash(SCRYPT_ALGORITHM_ID)).toBe(false)
    expect(needsRehash('scrypt$16384$8$1')).toBe(true)
    expect(needsRehash('scrypt$32768$4$1')).toBe(true)
    expect(needsRehash('not-an-algorithm')).toBe(true)
  })

  it('treats a password as its normalised form, so a keyboard cannot lock a user out', async () => {
    // The same text composed two ways: U+00E9, versus e followed by U+0301.
    const precomposed = 'café-Password-1'
    const decomposed = 'café-Password-1'
    expect(precomposed).not.toBe(decomposed)

    const record = await hashPassword(precomposed)

    await expect(verifyPassword(decomposed, record)).resolves.toBe(true)
  })
})
