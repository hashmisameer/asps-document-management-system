import { describe, expect, it } from 'vitest'
import { sanitiseMetadata } from '../../src/services/audit.service.js'

/**
 * The audit table is read by HR and Admin and kept for as long as the records
 * are. Anything that gets in there gets in there permanently, so these tests
 * are about what must never arrive rather than what should.
 */
describe('audit metadata sanitising', () => {
  it('redacts credential-shaped keys wherever they appear', () => {
    const result = sanitiseMetadata({
      username: 'hr1',
      // asps-dms:allow-secret - fixture proving these values never reach the table.
      password: 'Correct-Horse-1',
      nested: { token: 'abc123', sessionToken: 'def456', keep: 'visible' },
    }) as Record<string, unknown>

    expect(result.username).toBe('hr1')
    expect(result.password).toBe('[redacted]')

    const nested = result.nested as Record<string, unknown>
    expect(nested.token).toBe('[redacted]')
    expect(nested.sessionToken).toBe('[redacted]')
    expect(nested.keep).toBe('visible')
  })

  it('matches redacted keys regardless of case', () => {
    const result = sanitiseMetadata({ Password: 'x', TOKEN: 'y' }) as Record<string, unknown>

    expect(result.Password).toBe('[redacted]')
    expect(result.TOKEN).toBe('[redacted]')
  })

  it('never stores file contents', () => {
    const result = sanitiseMetadata({
      fileName: 'pan-card.pdf',
      fileBuffer: Buffer.from('%PDF-1.7 ...'),
      scan: Buffer.from('binary'),
    }) as Record<string, unknown>

    expect(result.fileName).toBe('pan-card.pdf')
    expect(result.fileBuffer).toBe('[redacted]')
    // Even under a key nobody thought to list, a Buffer is never serialised.
    expect(result.scan).toBe('[binary]')
  })

  it('caps long strings and deep structures', () => {
    const long = sanitiseMetadata({ note: 'x'.repeat(500) }) as { note: string }
    expect(long.note.length).toBeLessThanOrEqual(203)
    expect(long.note.endsWith('...')).toBe(true)

    const deep = sanitiseMetadata({ a: { b: { c: { d: { e: { f: 'too deep' } } } } } })
    expect(JSON.stringify(deep)).toContain('[truncated]')
  })

  it('keeps ordinary values usable, so the trail is worth reading', () => {
    const result = sanitiseMetadata({
      employeeId: 12,
      verified: true,
      at: new Date('2026-09-01T09:00:00.000Z'),
      documents: ['PAN_CARD', 'AADHAAR'],
      missing: null,
    }) as Record<string, unknown>

    expect(result).toEqual({
      employeeId: 12,
      verified: true,
      at: '2026-09-01T09:00:00.000Z',
      documents: ['PAN_CARD', 'AADHAAR'],
      missing: null,
    })
  })

  it('drops values that cannot be serialised rather than throwing', () => {
    const result = sanitiseMetadata({ callback: () => 'nope', tag: Symbol('x') }) as Record<
      string,
      unknown
    >

    expect(Object.keys(result)).toHaveLength(0)
  })
})
