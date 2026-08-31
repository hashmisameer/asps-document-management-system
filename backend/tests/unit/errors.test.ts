import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { API_ERROR_CODES } from '@asps-dms/shared'
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  describeError,
  isAppError,
} from '../../src/utils/errors.js'
import { parse, toValidationIssues } from '../../src/utils/validation.js'

describe('AppError', () => {
  it('defaults to the shared message for its code', () => {
    const error = new NotFoundError()

    expect(error.statusCode).toBe(404)
    expect(error.code).toBe(API_ERROR_CODES.NOT_FOUND)
    expect(error.message.length).toBeGreaterThan(0)
    expect(error.isServerError).toBe(false)
  })

  it('classifies 5xx as a server error and 4xx as not', () => {
    expect(new AppError(503, API_ERROR_CODES.SERVICE_UNAVAILABLE).isServerError).toBe(true)
    expect(new ForbiddenError().isServerError).toBe(false)
  })

  it('keeps the underlying cause off the message', () => {
    const cause = new Error('Login failed for user sa')
    const error = new AppError(500, API_ERROR_CODES.INTERNAL_ERROR, undefined, { cause })

    expect(error.message).not.toContain('Login failed')
    expect(error.cause).toBe(cause)
  })

  it('lets a caller narrow the code without a new subclass', () => {
    const error = new ConflictError(
      'That document has already been verified.',
      API_ERROR_CODES.INVALID_STATE_TRANSITION,
    )

    expect(error.statusCode).toBe(409)
    expect(error.code).toBe(API_ERROR_CODES.INVALID_STATE_TRANSITION)
  })

  it('recognises its own errors and nothing else', () => {
    expect(isAppError(new NotFoundError())).toBe(true)
    expect(isAppError(new Error('plain'))).toBe(false)
    expect(isAppError('not an error')).toBe(false)
  })
})

describe('describeError', () => {
  it('summarises without spreading an unknown value into the log', () => {
    expect(describeError(new TypeError('bad'))).toBe('TypeError: bad')
    expect(describeError('just a string')).toBe('just a string')
    // asps-dms:allow-secret - a fake password, and the point of the assertion.
    expect(describeError({ password: 'hunter2' })).not.toContain('hunter2')
  })
})

describe('parse', () => {
  const schema = z.object({
    username: z.string().min(1),
    page: z.coerce.number().int().min(1),
  })

  it('returns the parsed, coerced value', () => {
    const result = parse(schema, { username: 'hr1', page: '3' })

    expect(result).toEqual({ username: 'hr1', page: 3 })
  })

  it('throws a 400 ValidationError listing every offending field', () => {
    let thrown: unknown
    try {
      parse(schema, { username: '', page: 0 })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(ValidationError)
    const error = thrown as ValidationError
    expect(error.statusCode).toBe(400)
    expect(error.code).toBe(API_ERROR_CODES.VALIDATION_FAILED)

    const { issues } = error.details as { issues: { path: string }[] }
    expect(issues.map((issue) => issue.path).sort()).toEqual(['page', 'username'])
  })

  it('renders a nested path in dotted form', () => {
    const nested = z.object({ placements: z.array(z.object({ x: z.number() })) })
    const result = nested.safeParse({ placements: [{ x: 'left' }] })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(toValidationIssues(result.error)[0]?.path).toBe('placements.0.x')
  })
})
