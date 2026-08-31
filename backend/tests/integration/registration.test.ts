import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_SELF_REGISTRATIONS } from '@asps-dms/shared'
import { app, closeDatabase, ensureSchema, resetData } from './helpers.js'

/**
 * The registration cap, against a real database.
 *
 * This is the test that could not be written any other way. The cap is enforced
 * by a condition inside the INSERT, precisely so that a check-then-write cannot
 * be raced; mocking the database would only prove that the mock counts, which
 * is the one thing never in doubt.
 */

// asps-dms:allow-secret - a fixture password for a throwaway test database.
const PASSWORD = 'RegisterPass2026'

function registration(index: number) {
  return {
    username: `applicant${index}`,
    fullName: `Applicant ${index}`,
    role: 'HR' as const,
    password: PASSWORD,
    confirmPassword: PASSWORD,
  }
}

describe('self-registration', () => {
  beforeAll(async () => {
    await ensureSchema()
    await resetData()
  })

  afterAll(async () => {
    await closeDatabase()
  })

  it(`allows exactly ${MAX_SELF_REGISTRATIONS} accounts and then closes`, async () => {
    const express = app()

    for (let index = 1; index <= MAX_SELF_REGISTRATIONS; index += 1) {
      const response = await request(express).post('/api/auth/register').send(registration(index))
      expect(response.status, `registration ${index} should succeed`).toBe(201)
    }

    const overflow = await request(express)
      .post('/api/auth/register')
      .send(registration(MAX_SELF_REGISTRATIONS + 1))

    expect(overflow.status).toBe(403)
    expect(overflow.body.error.code).toBe('FORBIDDEN')

    const status = await request(express).get('/api/auth/registration')
    expect(status.body.registration.open).toBe(false)
    expect(status.body.registration.remaining).toBe(0)
  })

  it('holds the cap when registrations arrive at the same moment', async () => {
    // The reason the cap lives in the INSERT. Ten at once, against an empty
    // table: a check-then-write would let several past, because they all read
    // the count before any of them had written.
    await resetData()
    const express = app()

    const attempts = Array.from({ length: 10 }, (_, index) =>
      request(express).post('/api/auth/register').send(registration(index + 1)),
    )
    const results = await Promise.all(attempts)
    const created = results.filter((r) => r.status === 201)

    expect(created).toHaveLength(MAX_SELF_REGISTRATIONS)
    expect(results.filter((r) => r.status === 403)).toHaveLength(10 - MAX_SELF_REGISTRATIONS)
  })

  it('makes the first account on an empty system an administrator', async () => {
    await resetData()
    const express = app()

    const first = await request(express).post('/api/auth/register').send(registration(1))
    expect(first.status).toBe(201)
    expect(first.body.registered.role).toBe('ADMIN')

    // And only the first. The next one takes the role it asked for.
    const second = await request(express).post('/api/auth/register').send(registration(2))
    expect(second.body.registered.role).toBe('HR')
  })

  it('refuses a request that asks to be an administrator', async () => {
    await resetData()
    // Not the first account, so the bootstrap rule cannot be what grants it.
    await request(app()).post('/api/auth/register').send(registration(1))

    const response = await request(app())
      .post('/api/auth/register')
      .send({ ...registration(2), role: 'ADMIN' })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('lets a registered account sign in at once, with no forced password change', async () => {
    await resetData()
    const express = app()
    await request(express).post('/api/auth/register').send(registration(1))

    const login = await request(express)
      .post('/api/auth/login')
      .send({ username: 'applicant1', password: PASSWORD })

    expect(login.status).toBe(200)
    expect(login.body.user.mustChangePassword).toBe(false)
  })

  it('refuses a username that is already taken', async () => {
    await resetData()
    const express = app()
    await request(express).post('/api/auth/register').send(registration(1))

    const duplicate = await request(express).post('/api/auth/register').send(registration(1))
    expect(duplicate.status).toBe(409)
  })
})
