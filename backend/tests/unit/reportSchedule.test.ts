import { describe, expect, it } from 'vitest'
import { nextSendAt } from '../../src/services/reportSchedule.service.js'

/**
 * When the daily report goes out.
 *
 * The API keeps this schedule itself now, from REPORT_SEND_TIME - there is no
 * Windows task to recreate after a rebuild and no button on a screen. What can
 * go wrong is the arithmetic: sending twice in a day, or missing one.
 *
 * Local time throughout, because REPORT_SEND_TIME is what somebody in the office
 * reads off a clock. Every date here is built with the local constructor for the
 * same reason, so the test does not depend on where it runs.
 */

const at = (year: number, month: number, day: number, hours: number, minutes: number): Date =>
  new Date(year, month - 1, day, hours, minutes, 0, 0)

describe('nextSendAt', () => {
  it("waits for today's slot when it has not passed", () => {
    expect(nextSendAt(at(2026, 9, 5, 7, 30), '09:00')).toEqual(at(2026, 9, 5, 9, 0))
  })

  it('goes to tomorrow once the hour has gone by', () => {
    // Restarting the server in the afternoon must not send a second copy: this
    // schedules tomorrow, and the sender also remembers the day it last sent.
    expect(nextSendAt(at(2026, 9, 5, 16, 0), '09:00')).toEqual(at(2026, 9, 6, 9, 0))
  })

  it('treats the exact minute as gone rather than firing twice', () => {
    expect(nextSendAt(at(2026, 9, 5, 9, 0), '09:00')).toEqual(at(2026, 9, 6, 9, 0))
  })

  it('rolls over a month end', () => {
    expect(nextSendAt(at(2026, 9, 30, 23, 59), '09:00')).toEqual(at(2026, 10, 1, 9, 0))
  })

  it('rolls over a year end', () => {
    expect(nextSendAt(at(2026, 12, 31, 12, 0), '09:00')).toEqual(at(2027, 1, 1, 9, 0))
  })

  it('keeps whatever hour and minute were configured', () => {
    expect(nextSendAt(at(2026, 9, 5, 6, 0), '18:45')).toEqual(at(2026, 9, 5, 18, 45))
    expect(nextSendAt(at(2026, 9, 5, 0, 30), '00:05')).toEqual(at(2026, 9, 6, 0, 5))
  })

  it('lands on the wall clock rather than 24 hours later', () => {
    // Worked out from the calendar every time, so the hour stays put across a
    // daylight-saving change instead of drifting by one.
    const next = nextSendAt(at(2026, 3, 28, 12, 0), '09:00')

    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(0)
    expect(next.getDate()).toBe(29)
  })
})
