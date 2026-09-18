import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createRequest, sql } from '../../src/database/pool.js'
import * as userRepository from '../../src/repositories/user.repository.js'
import { closeDatabase, createUser, ensureSchema, resetData } from './helpers.js'

/**
 * `npm run user:list`, against a real database.
 *
 * The command used to select a Role column that dbo.Users does not have -
 * the role is a row in dbo.Roles - and no mocked test can catch a column
 * name, because a mock answers whatever it is asked. This one asks SQL
 * Server.
 */

describe('listing users', () => {
  beforeAll(async () => {
    await ensureSchema()
  })

  beforeEach(async () => {
    await resetData()
  })

  afterAll(async () => {
    await closeDatabase()
  })

  it('names each role from dbo.Roles, active accounts first, then by role and username', async () => {
    const viewer = await createUser('zara.viewer', 'VIEWER')
    const hr = await createUser('rakesh.hr', 'HR')
    const admin = await createUser('anita.admin', 'ADMIN')
    const gone = await createUser('old.hr', 'HR')

    // One disabled, one that has signed in: the two facts the listing notes.
    const request = await createRequest()
    await request
      .input('userId', sql.Int, gone.userId)
      .query('UPDATE dbo.Users SET IsActive = 0 WHERE UserId = @userId')
    await userRepository.recordSuccessfulLogin(hr.userId)

    const users = await userRepository.listAll()

    expect(users.map((user) => [user.username, user.role, user.isActive])).toEqual([
      ['anita.admin', 'ADMIN', true],
      ['rakesh.hr', 'HR', true],
      ['zara.viewer', 'VIEWER', true],
      ['old.hr', 'HR', false],
    ])
    expect(users.find((user) => user.userId === hr.userId)?.lastLoginAt).toBeInstanceOf(Date)
    expect(users.find((user) => user.userId === admin.userId)?.lastLoginAt).toBeNull()
    expect(users.find((user) => user.userId === viewer.userId)?.mustChangePassword).toBe(false)

    // Nothing that could open the account travels with the listing.
    for (const user of users) {
      expect(user).not.toHaveProperty('password')
      expect(Object.keys(user).some((key) => /hash|salt/i.test(key))).toBe(false)
    }
  })

  it('is empty, not an error, before anyone has a login', async () => {
    expect(await userRepository.listAll()).toEqual([])
  })
})
