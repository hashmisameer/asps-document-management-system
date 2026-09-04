import {
  DEADLINE_STATE,
  DEADLINE_UNITS,
  DEFAULT_DUE_SOON_THRESHOLD_DAYS,
  type DeadlineState,
  type DeadlineUnit,
} from '../constants/deadlines.js'
import { DOCUMENT_STATUS, type DocumentStatus } from '../constants/documents.js'
import { addDays, addMonths, daysBetween, monthsBetween, todayDateOnly } from './dateOnly.js'

/**
 * Computes a document's due date from the employee's joining date.
 *
 * Worked example from the specification (Section 20):
 *   joiningDate '2026-09-01' + 10 DAY  ->  '2026-09-11'
 *
 * Returns null when the document type carries no deadline, which is also the
 * case for documents uploaded on behalf of existing employees (Section 19).
 */
export function computeDueDate(
  joiningDate: string,
  deadlineValue: number | null,
  deadlineUnit: DeadlineUnit | null,
): string | null {
  if (deadlineValue === null || deadlineUnit === null) return null
  if (!Number.isInteger(deadlineValue) || deadlineValue < 0) {
    throw new RangeError(`deadlineValue must be a non-negative integer, received ${deadlineValue}`)
  }
  return deadlineUnit === DEADLINE_UNITS.MONTH
    ? addMonths(joiningDate, deadlineValue)
    : addDays(joiningDate, deadlineValue)
}

/** A document counts as complete once the file is in and not rejected. */
export function isDocumentComplete(status: DocumentStatus): boolean {
  return (
    status === DOCUMENT_STATUS.UPLOADED ||
    status === DOCUMENT_STATUS.UNDER_REVIEW ||
    status === DOCUMENT_STATUS.VERIFIED
  )
}

export interface DeadlineInfo {
  state: DeadlineState
  /** Positive = days remaining, negative = days overdue, null = not applicable. */
  daysRemaining: number | null
  /** Ready-to-render text, e.g. 'Due in 7 days', 'Overdue by 3 days'. */
  label: string
}

/**
 * Derives deadline state at read time.
 *
 * Deriving rather than storing is what makes 'Overdue' correct the moment it is
 * looked at, with no scheduled job and no stale flags to reconcile.
 */
export function deriveDeadline(
  dueDate: string | null,
  status: DocumentStatus,
  options: {
    today?: string
    dueSoonThresholdDays?: number
    /**
     * The employee has left, so nothing of theirs is still owed.
     *
     * A deadline counts down towards somebody doing something. Once they have
     * gone there is no longer anybody for it to count down towards, and a clock
     * left running says 'Overdue by 200 days' about a form nobody is going to
     * bring in - which is not a fact about the document, it is the system
     * failing to notice. It also poisons every report it appears in, because
     * that number grows for as long as the record exists.
     *
     * Deliberately NOT the same as a document being complete: the form really
     * is missing and still reads as Pending. It has simply stopped being late.
     */
    employeeHasLeft?: boolean
    /**
     * How this document's deadline was set, which is how it is counted back.
     *
     * The confirmation letter is due six MONTHS after joining, and 'Due in 168
     * days' is a number nobody converts in their head - the office thinks about
     * that one in months and reads every other document in days. Passing the
     * unit is what lets one function say both.
     *
     * Only the label changes. The state and daysRemaining are the same numbers
     * whatever the unit, so nothing that sorts or counts is affected.
     */
    deadlineUnit?: DeadlineUnit | null
  } = {},
): DeadlineInfo {
  const today = options.today ?? todayDateOnly()
  const threshold = options.dueSoonThresholdDays ?? DEFAULT_DUE_SOON_THRESHOLD_DAYS

  if (isDocumentComplete(status)) {
    return { state: DEADLINE_STATE.COMPLETED, daysRemaining: null, label: 'Completed' }
  }
  if (options.employeeHasLeft) {
    return {
      state: DEADLINE_STATE.NOT_APPLICABLE,
      daysRemaining: null,
      label: 'Not due - employee has left',
    }
  }
  if (dueDate === null) {
    return { state: DEADLINE_STATE.NOT_APPLICABLE, daysRemaining: null, label: 'No deadline' }
  }

  const daysRemaining = daysBetween(today, dueDate)
  const inMonths = options.deadlineUnit === DEADLINE_UNITS.MONTH

  if (daysRemaining < 0) {
    return {
      state: DEADLINE_STATE.OVERDUE,
      daysRemaining,
      label: `Overdue by ${inMonths ? overdueFor(dueDate, today) : dayCount(-daysRemaining)}`,
    }
  }
  if (daysRemaining === 0) {
    return { state: DEADLINE_STATE.DUE_TODAY, daysRemaining, label: 'Due today' }
  }
  const label = `Due in ${inMonths ? remainingFor(today, dueDate) : dayCount(daysRemaining)}`

  return daysRemaining <= threshold
    ? { state: DEADLINE_STATE.DUE_SOON, daysRemaining, label }
    : { state: DEADLINE_STATE.NOT_DUE, daysRemaining, label }
}

function dayCount(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

function monthCount(months: number): string {
  return `${months} ${months === 1 ? 'month' : 'months'}`
}

/**
 * How long is left, for a document counted in months.
 *
 * Months until the last whole one has gone, then days. 'Due in 0 months' says
 * nothing to somebody deciding whether to chase it this week, and the last few
 * weeks before a confirmation letter falls due are exactly when it is chased.
 */
function remainingFor(today: string, dueDate: string): string {
  const months = monthsBetween(today, dueDate)
  return months >= 1 ? monthCount(months) : dayCount(daysBetween(today, dueDate))
}

/** The same, the other way round: months once a whole one has passed. */
function overdueFor(dueDate: string, today: string): string {
  const months = monthsBetween(dueDate, today)
  return months >= 1 ? monthCount(months) : dayCount(daysBetween(dueDate, today))
}
