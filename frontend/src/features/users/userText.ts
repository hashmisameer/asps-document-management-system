import { ROLES, type Role, type UserListItem } from '@asps-dms/shared'

/**
 * The words in the Users table's cells, kept apart from the page so they can
 * be tested without rendering it.
 *
 * Two cells matter more than the rest. STATUS says whether somebody has ever
 * really signed in: a temporary password still unchanged means they were
 * given an account and have not used it - a fact, not a warning. SIGNATURE
 * says whether an HR or Admin user has an authorising signature on file,
 * because without one every document they upload comes out partly stamped;
 * 'none' has to be visible at a glance. A Viewer never signs anything, so for
 * them the cell says so rather than leaving a dash that reads as 'unknown'.
 */

export type UserFilter = 'all' | 'active' | 'inactive'

export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  [ROLES.ADMIN]: 'Administrator',
  [ROLES.HR]: 'HR',
  [ROLES.VIEWER]: 'Viewer',
}

export interface StatusCell {
  text: 'Active' | 'Inactive' | 'Has not signed in yet'
  /** Quiet for the ordinary states; 'fact' marks the not-yet-signed-in state. */
  tone: 'active' | 'inactive' | 'fact'
}

export function statusCell(
  user: Pick<UserListItem, 'isActive' | 'mustChangePassword'>,
): StatusCell {
  if (!user.isActive) return { text: 'Inactive', tone: 'inactive' }
  // Still on the temporary password: given an account, never used it.
  if (user.mustChangePassword) return { text: 'Has not signed in yet', tone: 'fact' }
  return { text: 'Active', tone: 'active' }
}

export interface SignatureCell {
  text: 'on file' | 'none' | 'not needed'
  /** 'missing' is the one to see at a glance. */
  tone: 'quiet' | 'missing'
  /** Said in the cell's title, so 'not needed' is never read as 'unknown'. */
  hint: string | null
}

export function signatureCell(user: Pick<UserListItem, 'role' | 'hasSignature'>): SignatureCell {
  if (user.role === ROLES.VIEWER) {
    return {
      text: 'not needed',
      tone: 'quiet',
      hint: 'A Viewer never signs anything, so no signature is needed - nobody should chase them for one.',
    }
  }
  return user.hasSignature
    ? { text: 'on file', tone: 'quiet', hint: null }
    : {
        text: 'none',
        tone: 'missing',
        hint: 'No authorising signature on file. Every document this user uploads comes out partly stamped until they add one under My signature.',
      }
}

export function filterUsers(users: readonly UserListItem[], filter: UserFilter): UserListItem[] {
  if (filter === 'all') return [...users]
  return users.filter((user) => (filter === 'active' ? user.isActive : !user.isActive))
}

export function filterCounts(users: readonly UserListItem[]): Record<UserFilter, number> {
  const active = users.filter((user) => user.isActive).length
  return { all: users.length, active, inactive: users.length - active }
}

/** Why an action on this row is not offered, or null when it is. */
export function actionRefusal(
  action: 'deactivate' | 'changeRole',
  target: UserListItem,
  me: { userId: number },
  activeAdmins: number,
): string | null {
  if (target.userId === me.userId) {
    return action === 'deactivate'
      ? 'You cannot deactivate your own account.'
      : 'You cannot change your own role.'
  }
  if (target.isActive && target.role === ROLES.ADMIN && activeAdmins <= 1) {
    return 'This is the last active administrator. Make somebody else an administrator first.'
  }
  return null
}

/** The one line the role dialog must say, because the rule is not obvious. */
export function roleDialogNote(windowDays: number): string {
  return (
    `An administrator can also add an employee with any past joining date; HR can only add ` +
    `someone who joined in the last ${windowDays} days.`
  )
}
