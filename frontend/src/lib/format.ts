import { isDateOnly, parseDateOnly } from '@asps-dms/shared'

/**
 * Display formatting.
 *
 * A calendar value ('YYYY-MM-DD') is rendered in UTC deliberately. Handing
 * '2026-09-01' to `new Date()` produces UTC midnight, and rendering that in a
 * timezone behind UTC shows 31 August - a joining date that is wrong by a day
 * for no reason the user could ever guess.
 *
 * A timestamp is the opposite case: it is a real instant, stored UTC, and is
 * shown in the reader's own timezone.
 */

/**
 * DD/MM/YYYY, the way the company writes dates on its own forms.
 *
 * Fixed rather than taken from the browser: a machine set to English (United
 * States) would otherwise render 1 August as 08/01/2026, and the whole point of
 * a date on this screen is that it agrees with the one printed on the document
 * beside it.
 */
const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

/** Shown where a date should be and there is nothing usable to put there. */
const NO_DATE = '-'

/**
 * A DATE A COMPONENT CANNOT RENDER MUST NOT TAKE THE PAGE DOWN.
 *
 * Intl throws RangeError on an invalid Date, and thrown from inside a render it
 * unmounts everything above it - the whole employee page goes white, with the
 * real message only in the browser console.
 *
 * That is not a theory. A timestamp was passed to formatDate, which reads
 * 'YYYY-MM-DD' by splitting on '-': the time part became NaN, the Date became
 * Invalid, and marking one document as Not required blanked the page for
 * everybody looking at that employee.
 *
 * So every value that is not a date it can read - null, undefined, an empty
 * string, a timestamp where a date was expected, anything at all - comes back
 * as a dash. A missing date on the screen is a small, visible, self-explaining
 * fault; an exception here is a blank page.
 */
/**
 * '2026-09-01' -> '01/09/2026'. Anything it cannot read is a dash.
 *
 * isDateOnly rather than a NaN check, and the difference matters: JavaScript
 * rolls an impossible date over instead of refusing it, so '2026-13-45' becomes
 * 14/02/2027 - a plausible wrong answer, which is worse than an obvious one.
 * The shared rule insists the value round-trips, so only a real calendar day in
 * 'YYYY-MM-DD' renders, and a timestamp does not.
 */
export function formatDate(dateOnly: string | null | undefined): string {
  if (!dateOnly || !isDateOnly(dateOnly)) return NO_DATE
  return DATE_FORMAT.format(parseDateOnly(dateOnly))
}

/** An ISO instant -> local date and time. Anything it cannot read is a dash. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return NO_DATE

  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? NO_DATE : DATE_TIME_FORMAT.format(parsed)
}

/** '1.4 MB'. Sizes are shown so someone can tell a scan from a photograph. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '-'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/**
 * DD/MM/YYYY typed by a person -> the ISO value everything else uses.
 *
 * Returns null for anything that is not a real date, INCLUDING one that is
 * well formed but impossible: 31/02/2026 is four digits in the right places and
 * is not a day, and accepting it would store a deadline nobody can meet.
 */
export function parseDisplayDate(text: string): string | null {
  const match = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(text.trim())
  if (!match) return null

  const day = Number(match[1])
  const month = Number(match[2])
  const year = Number(match[3])

  // Round-tripped through Date rather than range-checked by hand, so February
  // and leap years are the calendar's problem rather than this function's.
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }

  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)}`
}

/** The ISO value -> what the person types. Empty when there is nothing yet. */
export function toDisplayDate(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? formatDate(iso) : ''
}
