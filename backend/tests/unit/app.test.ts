import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_ERROR_CODES } from '@asps-dms/shared'

/**
 * HTTP foundation.
 *
 * These assertions are about the contract every future route inherits: one
 * error envelope, a correlation id on every response, and nothing internal
 * escaping to the caller. The database is mocked because none of that should
 * depend on a live SQL Server - and, at this milestone, there isn't one.
 */

const pingDatabase = vi.fn()

vi.mock('../../src/database/pool.js', () => ({
  pingDatabase: () => pingDatabase() as unknown,
}))

const { createApp } = await import('../../src/app.js')
const app = createApp()

beforeEach(() => {
  pingDatabase.mockReset()
})

describe('GET /api/health', () => {
  it('reports liveness without touching the database', async () => {
    const response = await request(app).get('/api/health')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ status: 'ok', service: 'asps-dms-api' })
    expect(pingDatabase).not.toHaveBeenCalled()
  })

  it('stamps a unique X-Request-Id on every response', async () => {
    const first = await request(app).get('/api/health')
    const second = await request(app).get('/api/health')

    expect(first.headers['x-request-id']).toBeTruthy()
    expect(second.headers['x-request-id']).toBeTruthy()
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id'])
  })

  it('ignores a client-supplied request id rather than trusting it', async () => {
    const response = await request(app).get('/api/health').set('X-Request-Id', 'client-chosen-id')

    expect(response.headers['x-request-id']).not.toBe('client-chosen-id')
  })

  it('does not advertise the server technology', async () => {
    const response = await request(app).get('/api/health')

    expect(response.headers['x-powered-by']).toBeUndefined()
  })
})

describe('GET /api/health/ready', () => {
  it('is ready when the database answers', async () => {
    pingDatabase.mockResolvedValue({ ok: true, latencyMs: 3 })

    const response = await request(app).get('/api/health/ready')

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('ready')
    expect(response.body.checks.database.ok).toBe(true)
  })

  it('answers 503 without leaking the driver message when it does not', async () => {
    pingDatabase.mockResolvedValue({
      ok: false,
      latencyMs: 15_000,
      error: 'Login failed for user sa on host db01',
    })

    const response = await request(app).get('/api/health/ready')

    expect(response.status).toBe(503)
    expect(response.body.status).toBe('unavailable')
    expect(JSON.stringify(response.body)).not.toContain('Login failed')
  })
})

describe('error envelope', () => {
  it('returns a coded 404 for an unmatched route', async () => {
    const response = await request(app).get('/api/not-a-route')

    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe(API_ERROR_CODES.NOT_FOUND)
    expect(typeof response.body.error.message).toBe('string')
    // referenceId is for server faults only; a 404 needs no log lookup.
    expect(response.body.error.referenceId).toBeUndefined()
  })

  it('rejects a malformed JSON body as INVALID_JSON, not as a 500', async () => {
    const response = await request(app)
      .post('/api/not-a-route')
      .set('Content-Type', 'application/json')
      .send('{"username": ')

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe(API_ERROR_CODES.INVALID_JSON)
  })

  it('rejects an oversized JSON body', async () => {
    const response = await request(app)
      .post('/api/not-a-route')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ note: 'x'.repeat(200_000) }))

    expect(response.status).toBe(413)
    expect(response.body.error.code).toBe(API_ERROR_CODES.PAYLOAD_TOO_LARGE)
  })

  it('answers 503, not 500, when the database is unreachable', async () => {
    // What tedious throws when SQL Server is not listening.
    pingDatabase.mockRejectedValue(
      Object.assign(new Error('Failed to connect to 10.0.0.5:1433'), {
        name: 'ConnectionError',
        code: 'ESOCKET',
      }),
    )

    const response = await request(app).get('/api/health/ready')

    expect(response.status).toBe(503)
    expect(response.body.error.code).toBe(API_ERROR_CODES.SERVICE_UNAVAILABLE)
    // Server-side fault, so it carries a reference - but not the host or port.
    expect(response.body.error.referenceId).toBeTruthy()
    expect(JSON.stringify(response.body)).not.toContain('1433')
  })

  it('never returns a stack trace', async () => {
    const response = await request(app).get('/api/not-a-route')

    expect(JSON.stringify(response.body)).not.toContain('at ')
    expect(response.body.error.stack).toBeUndefined()
  })
})
