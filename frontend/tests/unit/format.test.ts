import { describe, expect, it } from 'vitest'
import {
  formatDate,
  formatDateTime,
  parseDisplayDate,
  toDisplayDate,
} from '../../src/lib/format.js'

/**
 * Dates are written DD/MM/YYYY, and calendar values must not move.
 *
 * A joining date is a date, not an instant. Rendering '2026-09-01' with the
 * browser's local timezone shows 31 August anywhere behind UTC, which is a whole
 * day of deadline error nobody would think to look for.
 */
describe('formatDate', () => {
  it('renders DD/MM/YYYY', () => {
    expect(formatDate('2026-09-01')).toBe('01/09/2026')
    expect(formatDate('2026-08-01')).toBe('01/08/2026')
  })

  it('renders the same calendar day, not one shifted by a timezone', () => {
    expect(formatDate('2026-01-01')).toBe('01/01/2026')
  })

  it('shows a dash rather than "Invalid Date" when there is no value', () => {
    expect(formatDate(null)).toBe('-')
    expect(formatDateTime(null)).toBe('-')
  })
})

describe('parseDisplayDate', () => {
  it('reads DAY first, always', () => {
    // The whole reason this exists. A native date input follows the browser's
    // locale, and on a US-configured machine 01/08/2026 was stored as the 8th
    // of January - which is how a real employee record came to disagree with
    // the service card printed for them.
    expect(parseDisplayDate('01/08/2026')).toBe('2026-08-01')
    expect(parseDisplayDate('8/8/2026')).toBe('2026-08-08')
  })

  it('accepts the separators people actually type', () => {
    expect(parseDisplayDate('01-08-2026')).toBe('2026-08-01')
    expect(parseDisplayDate('01.08.2026')).toBe('2026-08-01')
    expect(parseDisplayDate('  01/08/2026  ')).toBe('2026-08-01')
  })

  it('refuses a date that is well formed and impossible', () => {
    // Four digits in the right places is not the same as a day. Accepting it
    // would store a deadline nobody can meet.
    expect(parseDisplayDate('31/02/2026')).toBeNull()
    expect(parseDisplayDate('32/01/2026')).toBeNull()
    expect(parseDisplayDate('01/13/2026')).toBeNull()
  })

  it('refuses anything half typed, rather than guessing at it', () => {
    expect(parseDisplayDate('')).toBeNull()
    expect(parseDisplayDate('01/0')).toBeNull()
    expect(parseDisplayDate('01/08/26')).toBeNull()
    expect(parseDisplayDate('2026-08-01')).toBeNull()
  })

  it('round-trips with toDisplayDate', () => {
    expect(toDisplayDate('2026-08-01')).toBe('01/08/2026')
    expect(parseDisplayDate(toDisplayDate('2026-08-01'))).toBe('2026-08-01')
    expect(toDisplayDate('')).toBe('')
  })
})

/**
 * A date these cannot read must never take the page down.
 *
 * REPORTED FROM THE SERVER, 2026-09-10: marking one document as Not required
 * blanked the whole employee page. A timestamp had been passed to formatDate,
 * which reads 'YYYY-MM-DD' by splitting on '-' - the time part became NaN, the
 * Date became Invalid, and Intl throws RangeError on an invalid Date. Thrown
 * from inside a render, that unmounts everything above it: white screen, and
 * the real message only in the browser console.
 *
 * A missing date on screen is a small, visible, self-explaining fault. An
 * exception is a blank page. These pin the first and forbid the second.
 */
describe('a date that cannot be read', () => {
  const UNREADABLE = [
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['only spaces', '   '],
    ['a word', 'not a date'],
    ['a half-typed date', '2026-'],
    ['a month that does not exist', '2026-13-45'],
    ['the 31st of February', '2026-02-31'],
    ['a timestamp where a date was expected', '2026-09-10T04:12:33.123Z'],
    ['a number as text', '1757480000000'],
  ] as const

  for (const [name, value] of UNREADABLE) {
    it(`shows a dash for ${name}, and does not throw`, () => {
      expect(() => formatDate(value)).not.toThrow()
      expect(formatDate(value)).toBe('-')
    })
  }

  it('shows a dash for a timestamp nothing can parse, and does not throw', () => {
    for (const value of [null, undefined, '', '   ', 'not a date', '2026-99-99T99:99:99Z']) {
      expect(() => formatDateTime(value)).not.toThrow()
      expect(formatDateTime(value)).toBe('-')
    }
  })

  it('still renders the values that ARE readable', () => {
    // The guard must not have made these quietly useless.
    expect(formatDate('2026-09-01')).toBe('01/09/2026')
    expect(formatDateTime('2026-09-10T04:12:33.123Z')).toContain('2026')
  })
})
