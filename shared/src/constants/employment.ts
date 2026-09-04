/**
 * Whether somebody still works here, and if not, how they left.
 *
 * Kept apart from `isActive`, which is this system's ARCHIVE flag. An employee
 * who has left is still reported on, still counted, still has documents that
 * must be produced years later; an archived record is one the office has
 * finished looking at. They are different questions and the answer to one says
 * nothing about the other - a leaver is normally not archived at all.
 */
export const EMPLOYMENT_STATUSES = {
  ACTIVE: 'ACTIVE',
  LEFT: 'LEFT',
} as const

export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[keyof typeof EMPLOYMENT_STATUSES]

export const ALL_EMPLOYMENT_STATUSES: readonly EmploymentStatus[] =
  Object.values(EMPLOYMENT_STATUSES)

export const EXIT_REASONS = {
  RESIGNED: 'RESIGNED',
  TERMINATED: 'TERMINATED',
  RETIRED: 'RETIRED',
  ABSCONDING: 'ABSCONDING',
} as const

export type ExitReason = (typeof EXIT_REASONS)[keyof typeof EXIT_REASONS]

export const ALL_EXIT_REASONS: readonly ExitReason[] = Object.values(EXIT_REASONS)

/** How a reason is written on screen. */
export const EXIT_REASON_LABEL: Readonly<Record<ExitReason, string>> = {
  [EXIT_REASONS.RESIGNED]: 'Resigned',
  [EXIT_REASONS.TERMINATED]: 'Terminated',
  [EXIT_REASONS.RETIRED]: 'Retired',
  [EXIT_REASONS.ABSCONDING]: 'Absconding',
}

/** Which employees a list is asking for. */
export const EMPLOYEE_STATUS_FILTERS = {
  ACTIVE: 'active',
  LEFT: 'left',
  ALL: 'all',
} as const

export type EmployeeStatusFilter =
  (typeof EMPLOYEE_STATUS_FILTERS)[keyof typeof EMPLOYEE_STATUS_FILTERS]

/**
 * Days worked, counting both the first day and the last.
 *
 * Somebody who joined and left on the same day worked one day, not none, which
 * is what a plain subtraction gives. Dates are compared as calendar days in UTC
 * so that a summer-time boundary between the two cannot shift the answer.
 */
export function daysWorked(joiningDate: string, lastWorkingDate: string): number | null {
  const from = Date.parse(`${joiningDate.slice(0, 10)}T00:00:00Z`)
  const to = Date.parse(`${lastWorkingDate.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null

  return Math.round((to - from) / 86_400_000) + 1
}
