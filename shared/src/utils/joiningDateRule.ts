import { ROLES, type Role } from '../constants/roles.js'
import { daysBetween } from './dateOnly.js'

/**
 * When an employee may be created, judged by the joining date.
 *
 * The office's rule, stated on 2026-09-18:
 *
 *   - Joined within the window (today and the days just before it): HR and an
 *     administrator may both create the record.
 *   - Joined earlier than that: HR is refused, and only an administrator may
 *     create it. A record entered late is a record whose deadlines are already
 *     running or already missed, and somebody senior should know it is being
 *     added.
 *   - Joining date in the future: nobody may create it, an administrator
 *     included. Nothing about a person who has not started yet belongs on the
 *     checklist, and every deadline would be computed from a guess.
 *
 * THE WINDOW COUNTS DATES, NOT DAYS. With a window of 7 the dates HR may use
 * are today and the six before it - seven dates. On 18 September that is
 * 12 to 18 September; 11 September is refused. The number is a setting on the
 * server (JOINING_DATE_WINDOW_DAYS) and the browser is told it, so both apply
 * the same one.
 *
 * ONE PLACE, THREE CALLERS. The Add Employee form, the bulk import and an edit
 * that changes the joining date all ask this function, on the server and in
 * the browser. The browser's answer is a warning shown early; the server's is
 * the one that counts.
 *
 * Pure: the caller supplies today, so it can be tested on any date and so the
 * server and the browser can each pass the date they hold. On the server that
 * is todayDateOnly() - the same today the deadlines use.
 */

export type JoiningDateRefusal = 'future' | 'too-old'

export interface JoiningDateJudgement {
  allowed: boolean
  reason?: JoiningDateRefusal
  /** Written for the person at the form: what is wrong, and what to do. */
  message?: string
}

export interface JoiningDateRuleInput {
  /** 'YYYY-MM-DD'. Already known to be a valid date. */
  joiningDate: string
  role: Role
  /** 'YYYY-MM-DD'. The server's own date. */
  today: string
  /** How many dates, today included, HR may use. */
  windowDays: number
}

export function futureJoiningDateMessage(): string {
  return 'The joining date cannot be in the future.'
}

export function oldJoiningDateMessage(windowDays: number): string {
  return (
    `This joining date is more than ${windowDays} days old. ` +
    'Only an administrator can add this employee.'
  )
}

export function judgeJoiningDate(input: JoiningDateRuleInput): JoiningDateJudgement {
  const { joiningDate, role, today, windowDays } = input

  // How far back the joining date is. Negative means it has not arrived yet.
  const daysAgo = daysBetween(joiningDate, today)

  if (daysAgo < 0) {
    return { allowed: false, reason: 'future', message: futureJoiningDateMessage() }
  }

  if (role === ROLES.ADMIN) return { allowed: true }

  // Today is day 0, so a window of 7 admits days 0 to 6.
  if (daysAgo >= windowDays) {
    return { allowed: false, reason: 'too-old', message: oldJoiningDateMessage(windowDays) }
  }

  return { allowed: true }
}
