/**
 * The office's clock, which is the server's.
 *
 * Times are STORED in UTC (SYSUTCDATETIME) and the driver sends a JS Date as
 * its UTC instant (useUTC). What a person means by 'yesterday' or '09:41' is
 * the office's own clock - and the server runs in the office, set to its time,
 * which is why `todayDateOnly()` reads the server-local date. These two are
 * the only way a date the office says, or a time the office reads, crosses
 * between the two: one answer, used by every report that asks.
 */

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * The moment an office day 'YYYY-MM-DD' begins, as an instant - midnight on
 * the server's clock. Bound as a parameter, it compares directly with a UTC
 * column. The day after's start is where the day ends: compare `< start of
 * the next day`, never `<= 23:59:59`, which drops the last second's uploads.
 */
export function officeDayStart(date: string): Date {
  return new Date(`${date}T00:00:00`)
}

/** '18/09/2026 09:41': a stored UTC instant as the office reads it. */
export function formatOfficeDateTime(iso: string): string {
  const at = new Date(iso)
  return (
    `${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  )
}
