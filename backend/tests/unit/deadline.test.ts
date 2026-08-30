import { describe, expect, it } from 'vitest'
import {
  DEADLINE_STATE,
  DEADLINE_UNITS,
  DOCUMENT_STATUS,
  addDays,
  addMonths,
  computeDueDate,
  daysBetween,
  deriveDeadline,
  isDateOnly,
} from '@asps-dms/shared'

describe('date-only arithmetic', () => {
  it('validates real calendar dates and rejects impossible ones', () => {
    expect(isDateOnly('2026-09-01')).toBe(true)
    expect(isDateOnly('2024-02-29')).toBe(true) // leap year
    expect(isDateOnly('2026-02-30')).toBe(false)
    expect(isDateOnly('2026-13-01')).toBe(false)
    expect(isDateOnly('2026-2-1')).toBe(false)
    expect(isDateOnly('01/09/2026')).toBe(false)
  })

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-09-01', 10)).toBe('2026-09-11')
    expect(addDays('2026-08-25', 10)).toBe('2026-09-04')
    expect(addDays('2026-12-27', 10)).toBe('2027-01-06')
  })

  it('clamps month arithmetic to the last valid day of the target month', () => {
    // The classic trap: naive month addition overflows into March.
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29') // leap year
    expect(addMonths('2026-03-31', 1)).toBe('2026-04-30')
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28')
    expect(addMonths('2026-09-01', 1)).toBe('2026-10-01')
  })

  it('counts whole days between two dates', () => {
    expect(daysBetween('2026-09-01', '2026-09-11')).toBe(10)
    expect(daysBetween('2026-09-11', '2026-09-01')).toBe(-10)
    expect(daysBetween('2026-09-01', '2026-09-01')).toBe(0)
    // Spans a DST changeover in most northern-hemisphere timezones; because the
    // arithmetic is UTC date-only this must still be exactly 31 days.
    expect(daysBetween('2026-10-15', '2026-11-15')).toBe(31)
  })
})

describe('computeDueDate', () => {
  it('matches the worked example from the specification', () => {
    // Joining 01 September + within 10 days -> due 11 September.
    expect(computeDueDate('2026-09-01', 10, DEADLINE_UNITS.DAY)).toBe('2026-09-11')
  })

  it('supports the 20-day and 1-month presets', () => {
    expect(computeDueDate('2026-09-01', 20, DEADLINE_UNITS.DAY)).toBe('2026-09-21')
    expect(computeDueDate('2026-09-01', 1, DEADLINE_UNITS.MONTH)).toBe('2026-10-01')
  })

  it('returns null when the document type carries no deadline', () => {
    expect(computeDueDate('2026-09-01', null, null)).toBeNull()
    expect(computeDueDate('2026-09-01', null, DEADLINE_UNITS.DAY)).toBeNull()
  })

  it('rejects a negative deadline rather than producing a past due date', () => {
    expect(() => computeDueDate('2026-09-01', -5, DEADLINE_UNITS.DAY)).toThrow(RangeError)
  })
})

describe('deriveDeadline', () => {
  const today = '2026-09-10'
  const pending = DOCUMENT_STATUS.PENDING

  it('reports days remaining ahead of the due date', () => {
    const info = deriveDeadline('2026-09-17', pending, { today })
    expect(info.state).toBe(DEADLINE_STATE.DUE_SOON)
    expect(info.daysRemaining).toBe(7)
    expect(info.label).toBe('Due in 7 days')
  })

  it('reports due today', () => {
    const info = deriveDeadline(today, pending, { today })
    expect(info.state).toBe(DEADLINE_STATE.DUE_TODAY)
    expect(info.daysRemaining).toBe(0)
    expect(info.label).toBe('Due today')
  })

  it('reports overdue with the number of days elapsed', () => {
    const info = deriveDeadline('2026-09-07', pending, { today })
    expect(info.state).toBe(DEADLINE_STATE.OVERDUE)
    expect(info.daysRemaining).toBe(-3)
    expect(info.label).toBe('Overdue by 3 days')
  })

  it('singularises a one-day label', () => {
    expect(deriveDeadline('2026-09-11', pending, { today }).label).toBe('Due in 1 day')
    expect(deriveDeadline('2026-09-09', pending, { today }).label).toBe('Overdue by 1 day')
  })

  it('is Not Due beyond the due-soon threshold', () => {
    expect(deriveDeadline('2026-10-01', pending, { today }).state).toBe(DEADLINE_STATE.NOT_DUE)
  })

  it('honours a configured due-soon threshold', () => {
    const info = deriveDeadline('2026-09-20', pending, { today, dueSoonThresholdDays: 14 })
    expect(info.state).toBe(DEADLINE_STATE.DUE_SOON)
  })

  it('treats an uploaded or verified document as completed, never overdue', () => {
    // A long-past due date must NOT show as overdue once the file is in.
    for (const status of [
      DOCUMENT_STATUS.UPLOADED,
      DOCUMENT_STATUS.UNDER_REVIEW,
      DOCUMENT_STATUS.VERIFIED,
    ]) {
      const info = deriveDeadline('2026-01-01', status, { today })
      expect(info.state).toBe(DEADLINE_STATE.COMPLETED)
      expect(info.daysRemaining).toBeNull()
    }
  })

  it('treats a rejected document as still outstanding', () => {
    const info = deriveDeadline('2026-09-07', DOCUMENT_STATUS.REJECTED, { today })
    expect(info.state).toBe(DEADLINE_STATE.OVERDUE)
  })

  it('reports no deadline when the document has no due date', () => {
    const info = deriveDeadline(null, pending, { today })
    expect(info.state).toBe(DEADLINE_STATE.NOT_APPLICABLE)
    expect(info.daysRemaining).toBeNull()
  })
})
