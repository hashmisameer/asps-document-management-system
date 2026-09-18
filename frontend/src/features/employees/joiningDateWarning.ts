import { isDateOnly, judgeJoiningDate, todayDateOnly, type SessionUser } from '@asps-dms/shared'

/**
 * What the Add Employee form says under the joining date, as it is typed.
 *
 * The same rule the server applies (judgeJoiningDate), with the window the
 * server sent at sign-in, so the answer here is the answer the save would get.
 * A warning only: the server judges again, against its own clock, and that is
 * the one that counts.
 *
 * Nothing is said until the date is a whole date - a half-typed year is not a
 * date in the future - and, on edit, nothing is said about a joining date that
 * is being sent back exactly as it was: correcting a phone number on an old
 * record is not adding a late employee.
 */
export function joiningDateWarning(input: {
  value: string
  user: Pick<SessionUser, 'role' | 'joiningDateWindowDays'> | null
  /** The joining date the record already has, when editing; null when adding. */
  existingJoiningDate: string | null
  today?: string
}): string | undefined {
  const { value, user, existingJoiningDate } = input
  if (!user || !isDateOnly(value)) return undefined
  if (existingJoiningDate !== null && value === existingJoiningDate) return undefined

  return judgeJoiningDate({
    joiningDate: value,
    role: user.role,
    today: input.today ?? todayDateOnly(),
    windowDays: user.joiningDateWindowDays,
  }).message
}
