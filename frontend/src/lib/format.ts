import { parseDateOnly } from '@asps-dms/shared'

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

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

/** '2026-09-01' -> '01 Sep 2026'. */
export function formatDate(dateOnly: string | null): string {
  if (!dateOnly) return '-'
  return DATE_FORMAT.format(parseDateOnly(dateOnly))
}

/** An ISO instant -> local date and time. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '-'
  return DATE_TIME_FORMAT.format(new Date(iso))
}

/** '1.4 MB'. Sizes are shown so someone can tell a scan from a photograph. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '-'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}
