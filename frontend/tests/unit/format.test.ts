import { describe, expect, it } from 'vitest'
import { formatDate, formatDateTime } from '../../src/lib/format.js'

/**
 * Calendar values must not move.
 *
 * A joining date is a date, not an instant. Rendering '2026-09-01' with the
 * browser's local timezone shows 31 August anywhere behind UTC, which is a
 * whole day of deadline error that nobody would think to look for.
 */
describe('formatDate', () => {
  // The month name is matched loosely because it comes from the runtime's own
  // locale data ('Sep' or 'Sept' depending on the ICU version). The day and the
  // year are what this is actually guarding.
  it('renders a date-only value as the same calendar day', () => {
    expect(formatDate('2026-09-01')).toMatch(/^01 Sep\w* 2026$/)
  })

  it('does not roll back over a year boundary', () => {
    expect(formatDate('2026-01-01')).toMatch(/^01 Jan\w* 2026$/)
  })

  it('shows a dash rather than "Invalid Date" when there is no value', () => {
    expect(formatDate(null)).toBe('-')
    expect(formatDateTime(null)).toBe('-')
  })
})
