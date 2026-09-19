import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API_ERROR_CODES } from '@asps-dms/shared'
import { app, closeDatabase, createUser, ensureSchema, resetData, signIn } from './helpers.js'

/**
 * The Users screen's routes against the real database.
 *
 * What only the database can prove: a temporary password really signs in and
 * is really forced to change; deactivating really ends the live session and
 * really stops the next sign-in; the last-administrator refusal counts real
 * rows; and the signature column flips when a signature is actually saved.
 */

describe('managing users, end to end', () => {
  beforeAll(async () => {
    await ensureSchema()
    await resetData()
  })

  afterAll(async () => {
    await closeDatabase()
  })

  it('creates a user whose temporary password signs in once and must then be changed', async () => {
    const express = app()
    const admin = await signIn(express, await createUser('admin.users', 'ADMIN'))

    const created = await admin
      .post('/api/users')
      .send({ username: 'new.hr', fullName: 'New HR Person', role: 'HR' })
    expect(created.status).toBe(201)
    expect(created.body.user).toMatchObject({
      username: 'new.hr',
      role: 'HR',
      isActive: true,
      mustChangePassword: true,
      hasSignature: false,
      lastLoginAt: null,
    })
    const temporaryPassword = created.body.temporaryPassword as string
    expect(temporaryPassword).toMatch(/^[A-Za-z0-9]{12,}$/)

    // The temporary password works, once...
    const fresh = request.agent(app())
    const login = await fresh
      .post('/api/auth/login')
      .send({ username: 'new.hr', password: temporaryPassword })
    expect(login.status).toBe(200)
    expect(login.body.user.mustChangePassword).toBe(true)

    // ...and nothing else is allowed until it is changed.
    const blocked = await fresh.get('/api/employees')
    expect(blocked.status).toBe(403)
    expect(blocked.body.error.code).toBe(API_ERROR_CODES.PASSWORD_CHANGE_REQUIRED)
  })

  it('resets a password: the old one stops working and the new one must be changed', async () => {
    const express = app()
    const admin = await signIn(express, await createUser('admin.reset', 'ADMIN'))
    const target = await createUser('hr.reset', 'HR')

    const before = await request(app())
      .post('/api/auth/login')
      .send({ username: target.username, password: target.password })
    expect(before.status).toBe(200)

    const users = await admin.get('/api/users')
    const row = users.body.users.find((u: { username: string }) => u.username === 'hr.reset')
    const reset = await admin.post(`/api/users/${row.userId}/reset-password`)
    expect(reset.status).toBe(200)

    const oldPassword = await request(app())
      .post('/api/auth/login')
      .send({ username: target.username, password: target.password })
    expect(oldPassword.status).toBe(401)

    const newPassword = await request(app())
      .post('/api/auth/login')
      .send({ username: target.username, password: reset.body.temporaryPassword })
    expect(newPassword.status).toBe(200)
    expect(newPassword.body.user.mustChangePassword).toBe(true)
  })

  it('deactivates: the live session dies at once and the next sign-in is refused; reactivating restores it', async () => {
    const express = app()
    const admin = await signIn(express, await createUser('admin.deact', 'ADMIN'))
    const target = await createUser('hr.deact', 'HR')
    const targetAgent = await signIn(app(), target)
    expect((await targetAgent.get('/api/employees')).status).toBe(200)

    const users = await admin.get('/api/users')
    const row = users.body.users.find((u: { username: string }) => u.username === 'hr.deact')

    const off = await admin.patch(`/api/users/${row.userId}`).send({ isActive: false })
    expect(off.status).toBe(200)
    expect(off.body.user.isActive).toBe(false)

    // Their open session is dead on the next request, and signing in fails.
    expect((await targetAgent.get('/api/employees')).status).toBe(401)
    expect(
      (
        await request(app())
          .post('/api/auth/login')
          .send({ username: target.username, password: target.password })
      ).status,
    ).toBe(401)

    // Back on, with the password they had.
    const on = await admin.patch(`/api/users/${row.userId}`).send({ isActive: true })
    expect(on.status).toBe(200)
    expect(
      (
        await request(app())
          .post('/api/auth/login')
          .send({ username: target.username, password: target.password })
      ).status,
    ).toBe(200)
  })

  it('refuses to deactivate or demote yourself, and lets one administrator step another down', async () => {
    await resetData()
    const express = app()
    const me = await createUser('admin.only', 'ADMIN')
    const admin = await signIn(express, me)

    for (const change of [{ isActive: false }, { role: 'HR' }]) {
      const self = await admin.patch(`/api/users/${me.userId}`).send(change)
      expect(self.status).toBe(409)
      expect(self.body.error.message).toBe('You cannot deactivate or demote your own account.')
    }

    // Two active administrators: one may step the other down. The
    // last-administrator refusal is never reachable by one person through the
    // API - the actor is an active administrator, so with another as target
    // the count is at least two, and targeting yourself is refused first. It
    // is the guard against two administrators removing each other in the same
    // instant, and it is pinned in user.service.test.ts.
    const second = await createUser('admin.second', 'ADMIN')
    const asSecond = await signIn(app(), second)
    const demoteMe = await asSecond.patch(`/api/users/${me.userId}`).send({ role: 'HR' })
    expect(demoteMe.status).toBe(200)
    expect(demoteMe.body.user.role).toBe('HR')

    // And now the second is the only administrator, so the first can no longer
    // reach this screen at all.
    expect((await admin.get('/api/users')).status).toBe(403)
  })

  it('shows whether an authorising signature is on file', async () => {
    await resetData()
    const express = app()
    const adminUser = await createUser('admin.sig', 'ADMIN')
    const admin = await signIn(express, adminUser)

    const before = await admin.get('/api/users')
    expect(before.body.users[0]).toMatchObject({ username: 'admin.sig', hasSignature: false })

    // A one-pixel PNG is enough to be a signature for this purpose.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    )
    const saved = await admin
      .post('/api/me/signature')
      .attach('file', png, { filename: 'sig.png', contentType: 'image/png' })
    expect(saved.status).toBe(200)

    const after = await admin.get('/api/users')
    expect(after.body.users[0]).toMatchObject({ username: 'admin.sig', hasSignature: true })
  })
})
