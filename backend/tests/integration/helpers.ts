import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../../src/app.js'
import { createRequest, getPool } from '../../src/database/pool.js'
import { runMigrations, runSeeds } from '../../src/database/migrate.js'
import { hashPassword } from '../../src/services/password.service.js'
import * as userRepository from '../../src/repositories/user.repository.js'

/**
 * Shared plumbing for the integration tests.
 *
 * These run against a real SQL Server - the database named by
 * tests/setup/integration-env.ts, which is forced to end in _TEST because
 * everything here deletes rows to reach a known starting state.
 */

let migrated = false

/** Applies the schema and seeds once per run. Idempotent, like the runner. */
export async function ensureSchema(): Promise<void> {
  if (migrated) return
  await runMigrations()
  await runSeeds()
  migrated = true
}

/**
 * Empties everything a test creates, in an order the foreign keys allow.
 *
 * Roles and document types are left: they are seed data, not test data, and
 * re-seeding them on every file would be slow and would hide a seed that had
 * stopped working. Everything else goes, so no test can pass because of a row
 * another test happened to leave behind.
 */
export async function resetData(): Promise<void> {
  const req = await createRequest()
  await req.query(`
    SET QUOTED_IDENTIFIER ON;
    DELETE FROM dbo.SignaturePlacements;
    DELETE FROM dbo.EmployeeSignatures;
    DELETE FROM dbo.UserSignatures;
    DELETE FROM dbo.EmployeeDocuments;
    DELETE FROM dbo.Employees;
    DELETE FROM dbo.Sessions;
    DELETE FROM dbo.AuditLogs;
    DELETE FROM dbo.Users;
  `)
}

export function app(): Express {
  return createApp()
}

export interface TestUser {
  userId: number
  username: string
  password: string
}

/**
 * An account created the way an administrator creates one, then put through the
 * forced password change so it can be used.
 */
export async function createUser(
  username: string,
  role: 'ADMIN' | 'HR' | 'VIEWER',
): Promise<TestUser> {
  // asps-dms:allow-secret - a fixture password for a throwaway test database.
  const password = 'IntegrationPass2026'
  const userId = await userRepository.createUser({
    username,
    fullName: `${username} test`,
    role,
    password: await hashPassword(password),
    mustChangePassword: false,
  })
  return { userId, username, password }
}

/**
 * A supertest agent that has signed in and is holding the session cookie.
 *
 * An agent rather than a bare request, because the session is an httpOnly
 * cookie and every later call has to carry it - which is also how the real
 * client works.
 */
export async function signIn(
  express: Express,
  user: TestUser,
): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(express)
  const response = await agent
    .post('/api/auth/login')
    .send({ username: user.username, password: user.password })

  if (response.status !== 200) {
    throw new Error(`Could not sign in as ${user.username}: ${response.status}`)
  }
  return agent
}

/** Closes the pool so vitest is not left with an open handle. */
export async function closeDatabase(): Promise<void> {
  const pool = await getPool()
  await pool.close()
}
