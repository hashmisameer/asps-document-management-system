/**
 * Deadline configuration and derived deadline state.
 *
 * DueDate is computed ONCE when the employee checklist is created
 * (JoiningDate + DeadlineValue DeadlineUnit) and stored, so it is stable and
 * indexable. The *state* below is derived at read time from DueDate vs today,
 * which is why 'Overdue' is always correct without any scheduled job.
 */

export const DEADLINE_UNITS = {
  DAY: 'DAY',
  MONTH: 'MONTH',
} as const

export type DeadlineUnit = (typeof DEADLINE_UNITS)[keyof typeof DEADLINE_UNITS]

export const DEADLINE_STATE = {
  NOT_APPLICABLE: 'NotApplicable',
  COMPLETED: 'Completed',
  NOT_DUE: 'NotDue',
  DUE_SOON: 'DueSoon',
  DUE_TODAY: 'DueToday',
  OVERDUE: 'Overdue',
} as const

export type DeadlineState = (typeof DEADLINE_STATE)[keyof typeof DEADLINE_STATE]

export const DEADLINE_STATE_LABEL: Readonly<Record<DeadlineState, string>> = {
  [DEADLINE_STATE.NOT_APPLICABLE]: 'No deadline',
  [DEADLINE_STATE.COMPLETED]: 'Completed',
  [DEADLINE_STATE.NOT_DUE]: 'Not due',
  [DEADLINE_STATE.DUE_SOON]: 'Due soon',
  [DEADLINE_STATE.DUE_TODAY]: 'Due today',
  [DEADLINE_STATE.OVERDUE]: 'Overdue',
}

/**
 * ASSUMPTION (pending company confirmation, docs/open-questions.md Q7):
 * a document is "Due Soon" within 7 days of its due date. Becomes a Settings
 * value in Milestone 5.
 */
export const DEFAULT_DUE_SOON_THRESHOLD_DAYS = 7

/** Preset options offered to HR when configuring a document type deadline. */
export const DEADLINE_PRESETS: readonly {
  label: string
  value: number
  unit: DeadlineUnit
}[] = [
  { label: 'Within 10 days', value: 10, unit: DEADLINE_UNITS.DAY },
  { label: 'Within 15 days', value: 15, unit: DEADLINE_UNITS.DAY },
  { label: 'Within 20 days', value: 20, unit: DEADLINE_UNITS.DAY },
  { label: 'Within 30 days', value: 30, unit: DEADLINE_UNITS.DAY },
  { label: 'Within 1 month', value: 1, unit: DEADLINE_UNITS.MONTH },
  { label: 'Within 2 months', value: 2, unit: DEADLINE_UNITS.MONTH },
  { label: 'Within 3 months', value: 3, unit: DEADLINE_UNITS.MONTH },
]
