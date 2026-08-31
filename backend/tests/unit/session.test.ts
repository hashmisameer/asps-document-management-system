import { describe, expect, it } from 'vitest'
import {
  checkSessionValidity,
  computeSessionExpiry,
  generateSessionToken,
  hashSessionToken,
  nextIdleExpiry,
  shouldTouchSession,
} from '../../src/services/session.service.js'

const NOW = new Date('2026-09-01T09:00:00.000Z')

describe('session tokens', () => {
  it('produces a cookie-safe token that is never the same twice', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateSessionToken()))

    expect(tokens.size).toBe(200)
    for (const token of tokens) {
      // base64url: no +, / or = to be escaped on the way into a cookie.
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(token.length).toBeGreaterThanOrEqual(40)
    }
  })

  it('hashes to exactly the 32 bytes dbo.Sessions.TokenHash stores', () => {
    const token = generateSessionToken()

    const hash = hashSessionToken(token)
    expect(hash.length).toBe(32)
    // Deterministic, or the lookup on the next request would miss.
    expect(hashSessionToken(token).equals(hash)).toBe(true)
    expect(hashSessionToken(generateSessionToken()).equals(hash)).toBe(false)
  })
})

describe('session expiry', () => {
  it('sets an idle expiry and a separate absolute ceiling', () => {
    const { expiresAt, absoluteExpiry } = computeSessionExpiry(NOW, 480, 24)

    expect(expiresAt.toISOString()).toBe('2026-09-01T17:00:00.000Z')
    expect(absoluteExpiry.toISOString()).toBe('2026-09-02T09:00:00.000Z')
  })

  it('never issues an idle expiry past the ceiling', () => {
    // Idle TTL longer than the absolute TTL: the ceiling has to win, or it is
    // not a ceiling.
    const { expiresAt, absoluteExpiry } = computeSessionExpiry(NOW, 480, 2)

    expect(expiresAt.toISOString()).toBe(absoluteExpiry.toISOString())
  })

  it('extends an active session, still bounded by the ceiling', () => {
    const absoluteExpiry = new Date('2026-09-02T09:00:00.000Z')

    expect(nextIdleExpiry(NOW, 480, absoluteExpiry).toISOString()).toBe(
      '2026-09-01T17:00:00.000Z',
    )

    // Late in the session's life, the extension is clamped.
    const nearTheEnd = new Date('2026-09-02T06:00:00.000Z')
    expect(nextIdleExpiry(nearTheEnd, 480, absoluteExpiry).toISOString()).toBe(
      absoluteExpiry.toISOString(),
    )
  })

  it('writes the extension at most once a minute', () => {
    const lastSeenAt = new Date('2026-09-01T09:00:00.000Z')

    expect(shouldTouchSession(lastSeenAt, new Date('2026-09-01T09:00:30.000Z'))).toBe(false)
    expect(shouldTouchSession(lastSeenAt, new Date('2026-09-01T09:01:00.000Z'))).toBe(true)
    expect(shouldTouchSession(lastSeenAt, new Date('2026-09-01T11:00:00.000Z'))).toBe(true)
  })
})

describe('session validity', () => {
  const live = {
    revokedAt: null,
    expiresAt: new Date('2026-09-01T17:00:00.000Z'),
    absoluteExpiry: new Date('2026-09-02T09:00:00.000Z'),
  }

  it('accepts a live session', () => {
    expect(checkSessionValidity(live, NOW)).toEqual({ valid: true })
  })

  it('rejects a revoked session even while it is otherwise in date', () => {
    const result = checkSessionValidity(
      { ...live, revokedAt: new Date('2026-09-01T08:59:00.000Z') },
      NOW,
    )

    expect(result.valid).toBe(false)
    expect(result.reason).toBe('revoked')
  })

  it('rejects an idle-expired session', () => {
    const result = checkSessionValidity(
      { ...live, expiresAt: new Date('2026-09-01T08:59:59.000Z') },
      NOW,
    )

    expect(result.valid).toBe(false)
    expect(result.reason).toBe('idle-expired')
  })

  it('rejects a session past its ceiling, whatever its idle expiry says', () => {
    const result = checkSessionValidity(
      {
        ...live,
        expiresAt: new Date('2026-09-01T17:00:00.000Z'),
        absoluteExpiry: new Date('2026-09-01T08:00:00.000Z'),
      },
      NOW,
    )

    expect(result.valid).toBe(false)
    expect(result.reason).toBe('absolute-expired')
  })
})
