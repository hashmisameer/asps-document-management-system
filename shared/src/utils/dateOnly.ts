/**
 * Date-only arithmetic ('YYYY-MM-DD').
 *
 * Deadlines are calendar facts, not instants. Doing this arithmetic with local
 * Date objects makes results depend on the server's timezone and on DST, which
 * would let a due date drift by a day. Everything here works in UTC on a
 * date-only string and never touches the local clock.
 */

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

export function isDateOnly(value: string): boolean {
  if (!DATE_ONLY_RE.test(value)) return false
  const parsed = parseDateOnly(value)
  return formatDateOnly(parsed) === value
}

/** Parses 'YYYY-MM-DD' into a UTC-midnight Date. */
export function parseDateOnly(value: string): Date {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d))
}

/** Formats a Date back to 'YYYY-MM-DD' using its UTC components. */
export function formatDateOnly(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, '0')
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0')
  const d = date.getUTCDate().toString().padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function addDays(value: string, days: number): string {
  const date = parseDateOnly(value)
  date.setUTCDate(date.getUTCDate() + days)
  return formatDateOnly(date)
}

/**
 * Adds calendar months, clamping to the last valid day of the target month.
 *
 * 31 Jan + 1 month  -> 28 Feb (29 Feb in a leap year), not 3 March.
 * Naive setUTCMonth would overflow into the following month.
 */
export function addMonths(value: string, months: number): string {
  const date = parseDateOnly(value)
  const targetMonth = date.getUTCMonth() + months
  const year = date.getUTCFullYear() + Math.floor(targetMonth / 12)
  const month = ((targetMonth % 12) + 12) % 12
  const dayInMonth = date.getUTCDate()
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const day = Math.min(dayInMonth, lastDayOfTargetMonth)
  return formatDateOnly(new Date(Date.UTC(year, month, day)))
}

/** Whole days from `from` to `to`. Positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  const MS_PER_DAY = 86_400_000
  return Math.round((parseDateOnly(to).getTime() - parseDateOnly(from).getTime()) / MS_PER_DAY)
}

/** Today as a date-only string in the given IANA timezone (server-local by default). */
export function todayDateOnly(timeZone?: string): string {
  const now = new Date()
  if (!timeZone) {
    const y = now.getFullYear().toString().padStart(4, '0')
    const m = (now.getMonth() + 1).toString().padStart(2, '0')
    const d = now.getDate().toString().padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}
