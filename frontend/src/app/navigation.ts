import { PERMISSIONS, roleHasPermission, type Permission, type Role } from '@asps-dms/shared'

/**
 * The navigation, derived from permissions rather than from roles.
 *
 * Adding a role means adding it to ROLE_PERMISSIONS and nothing else: this list
 * keeps working. A Viewer never sees Users; HR does not either, because user
 * management is Admin-only.
 *
 * This decides what is DRAWN. Every route behind it is enforced server-side as
 * well, so a hidden item is a courtesy and never the control.
 */
export interface NavItem {
  to: string
  label: string
  /** Null means every signed-in user sees it. */
  permission: Permission | null
  /** 'planned' items render a placeholder naming the milestone that brings them. */
  status: 'ready' | 'planned'
}

// 'My signature' is deliberately NOT here. It is the signed-in user's own
// authorising signature - a personal setting, like the password - and sitting in
// the main nav it read as though it were the employees' signatures, which live
// on their own records. It is in the header beside Password instead.
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Dashboard', permission: null, status: 'ready' },
  { to: '/employees', label: 'Employees', permission: PERMISSIONS.EMPLOYEE_READ, status: 'ready' },
  { to: '/reports', label: 'Reports', permission: PERMISSIONS.REPORT_READ, status: 'planned' },
  { to: '/users', label: 'Users', permission: PERMISSIONS.USER_MANAGE, status: 'planned' },
]

export function visibleNavItems(role: Role | null): NavItem[] {
  if (!role) return []
  return NAV_ITEMS.filter((item) => item.permission === null || roleHasPermission(role, item.permission))
}
