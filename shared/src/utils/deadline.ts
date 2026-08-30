import {
  DEADLINE_STATE,
  DEADLINE_UNITS,
  DEFAULT_DUE_SOON_THRESHOLD_DAYS,
  type DeadlineState,
  type DeadlineUnit,
} from '../constants/deadlines.js'
import { DOCUMENT_STATUS, type DocumentStatus } from '../constants/documents.js'
import { addDays, addMonths, daysBetween, todayDateOnly } from './dateOnly.js'

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
  options: { today?: string; dueSoonThresholdDays?: number } = {},
): DeadlineInfo {
  const today = options.today ?? todayDateOnly()
  const threshold = options.dueSoonThresholdDays ?? DEFAULT_DUE_SOON_THRESHOLD_DAYS

  if (isDocumentComplete(status)) {
    return { state: DEADLINE_STATE.COMPLETED, daysRemaining: null, label: 'Completed' }
  }
  if (dueDate === null) {
    return { state: DEADLINE_STATE.NOT_APPLICABLE, daysRemaining: null, label: 'No deadline' }
  }

  const daysRemaining = daysBetween(today, dueDate)

  if (daysRemaining < 0) {
    const overdueBy = Math.abs(daysRemaining)
    return {
      state: DEADLINE_STATE.OVERDUE,
      daysRemaining,
      label: `Overdue by ${overdueBy} ${pluralDays(overdueBy)}`,
    }
  }
  if (daysRemaining === 0) {
    return { state: DEADLINE_STATE.DUE_TODAY, daysRemaining, label: 'Due today' }
  }
  if (daysRemaining <= threshold) {
    return {
      state: DEADLINE_STATE.DUE_SOON,
      daysRemaining,
      label: `Due in ${daysRemaining} ${pluralDays(daysRemaining)}`,
    }
  }
  return {
    state: DEADLINE_STATE.NOT_DUE,
    daysRemaining,
    label: `Due in ${daysRemaining} ${pluralDays(daysRemaining)}`,
  }
}

function pluralDays(n: number): string {
  return n === 1 ? 'day' : 'days'
}
