import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { PERMISSIONS, ROLES, type AuthUser } from '@asps-dms/shared'
import { requirePasswordChanged, requirePermission } from '../../src/middleware/requireAuth.js'
import { AppError } from '../../src/utils/errors.js'

/**
 * Authorisation is enforced here and only here. The frontend uses the same
 * permission map to decide what to draw, but a hidden button is a courtesy -
 * these are the checks that actually stop anything.
 */

function fakeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: 1,
    username: 'hr1',
    fullName: 'Priya Sharma',
    role: ROLES.HR,
    mustChangePassword: false,
    ...overrides,
  }
}

function run(handler: ReturnType<typeof requirePermission>, user: AuthUser | undefined) {
  const next = vi.fn() as unknown as NextFunction
  handler({ user } as Request, {} as Response, next)
  return next as unknown as ReturnType<typeof vi.fn>
}

describe('requirePermission', () => {
  it('lets HR verify a document', () => {
    const next = run(requirePermission(PERMISSIONS.DOCUMENT_VERIFY), fakeUser())

    expect(next).toHaveBeenCalledWith()
  })

  it('stops a Viewer verifying a document', () => {
    const next = run(
      requirePermission(PERMISSIONS.DOCUMENT_VERIFY),
      fakeUser({ role: ROLES.VIEWER }),
    )

    const error = next.mock.calls[0]?.[0] as AppError
    expect(error).toBeInstanceOf(AppError)
    expect(error.statusCode).toBe(403)
  })

  it('stops HR managing users, which is Admin only', () => {
    const next = run(requirePermission(PERMISSIONS.USER_MANAGE), fakeUser())

    expect((next.mock.calls[0]?.[0] as AppError).statusCode).toBe(403)
  })

  it('lets Admin manage users', () => {
    const next = run(requirePermission(PERMISSIONS.USER_MANAGE), fakeUser({ role: ROLES.ADMIN }))

    expect(next).toHaveBeenCalledWith()
  })

  it('allows a Viewer to preview but not download, per the standing assumption', () => {
    const viewer = fakeUser({ role: ROLES.VIEWER })

    expect(run(requirePermission(PERMISSIONS.DOCUMENT_PREVIEW), viewer)).toHaveBeenCalledWith()
    expect(
      (run(requirePermission(PERMISSIONS.DOCUMENT_DOWNLOAD), viewer).mock.calls[0]?.[0] as AppError)
        .statusCode,
    ).toBe(403)
  })

  it('fails closed when no user is attached', () => {
    // Only reachable by mounting it without requireAuth - a wiring mistake that
    // must not become an open door.
    const next = run(requirePermission(PERMISSIONS.EMPLOYEE_READ), undefined)

    expect((next.mock.calls[0]?.[0] as AppError).statusCode).toBe(401)
  })
})

describe('requirePasswordChanged', () => {
  it('lets a normal user through', () => {
    const next = vi.fn()
    requirePasswordChanged({ user: fakeUser() } as Request, {} as Response, next)

    expect(next).toHaveBeenCalledWith()
  })

  it('blocks an account that still has to set a new password', () => {
    const next = vi.fn()
    requirePasswordChanged(
      { user: fakeUser({ mustChangePassword: true }) } as Request,
      {} as Response,
      next,
    )

    const error = next.mock.calls[0]?.[0] as AppError
    expect(error.statusCode).toBe(403)
    expect(error.code).toBe('PASSWORD_CHANGE_REQUIRED')
  })
})
