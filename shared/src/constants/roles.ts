/**
 * Roles and permissions.
 *
 * RBAC is data-driven: adding a role later means adding a row to dbo.Roles and
 * an entry to ROLE_PERMISSIONS. No route, controller or component changes.
 */

export const ROLES = {
  HR: 'HR',
  VIEWER: 'VIEWER',
  ADMIN: 'ADMIN',
} as const

export type Role = (typeof ROLES)[keyof typeof ROLES]

export const ALL_ROLES: readonly Role[] = Object.values(ROLES)

/**
 * Permissions are `<entity>:<action>` strings. They are checked server-side on
 * every mutating route; the frontend uses the same list only to decide what to
 * render. The frontend check is never the security boundary.
 */
export const PERMISSIONS = {
  EMPLOYEE_READ: 'employee:read',
  EMPLOYEE_CREATE: 'employee:create',
  EMPLOYEE_UPDATE: 'employee:update',
  EMPLOYEE_ARCHIVE: 'employee:archive',

  DOCUMENT_READ: 'document:read',
  DOCUMENT_PREVIEW: 'document:preview',
  DOCUMENT_DOWNLOAD: 'document:download',
  DOCUMENT_UPLOAD: 'document:upload',
  DOCUMENT_REPLACE: 'document:replace',
  DOCUMENT_VERIFY: 'document:verify',
  DOCUMENT_REJECT: 'document:reject',
  DOCUMENT_ARCHIVE: 'document:archive',

  DEADLINE_UPDATE: 'deadline:update',

  SIGNATURE_READ: 'signature:read',
  SIGNATURE_UPLOAD: 'signature:upload',
  SIGNATURE_DETECT: 'signature:detect',
  SIGNATURE_PLACE: 'signature:place',
  SIGNATURE_SKIP: 'signature:skip',

  DOCUMENT_TYPE_READ: 'documentType:read',
  DOCUMENT_TYPE_MANAGE: 'documentType:manage',

  /** Sending the pending-documents digest by email, now rather than on schedule. */
  REMINDER_SEND: 'reminder:send',

  REPORT_READ: 'report:read',
  AUDIT_READ: 'audit:read',
  USER_MANAGE: 'user:manage',
  SETTINGS_MANAGE: 'settings:manage',
} as const

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

const HR_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.EMPLOYEE_READ,
  PERMISSIONS.EMPLOYEE_CREATE,
  PERMISSIONS.EMPLOYEE_UPDATE,
  PERMISSIONS.EMPLOYEE_ARCHIVE,
  PERMISSIONS.DOCUMENT_READ,
  PERMISSIONS.DOCUMENT_PREVIEW,
  PERMISSIONS.DOCUMENT_DOWNLOAD,
  PERMISSIONS.DOCUMENT_UPLOAD,
  PERMISSIONS.DOCUMENT_REPLACE,
  PERMISSIONS.DOCUMENT_VERIFY,
  PERMISSIONS.DOCUMENT_REJECT,
  PERMISSIONS.DOCUMENT_ARCHIVE,
  PERMISSIONS.DEADLINE_UPDATE,
  PERMISSIONS.SIGNATURE_READ,
  PERMISSIONS.SIGNATURE_UPLOAD,
  PERMISSIONS.SIGNATURE_DETECT,
  PERMISSIONS.SIGNATURE_PLACE,
  PERMISSIONS.SIGNATURE_SKIP,
  PERMISSIONS.DOCUMENT_TYPE_READ,
  PERMISSIONS.DOCUMENT_TYPE_MANAGE,
  PERMISSIONS.REMINDER_SEND,
  PERMISSIONS.REPORT_READ,
  PERMISSIONS.AUDIT_READ,
  PERMISSIONS.SETTINGS_MANAGE,
]

/**
 * Management / Viewer is read-only.
 *
 * ASSUMPTION (pending company confirmation, see docs/open-questions.md Q6):
 * Viewers may PREVIEW documents but may NOT download them. Flip by adding
 * PERMISSIONS.DOCUMENT_DOWNLOAD to this list — no other change is required.
 */
const VIEWER_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.EMPLOYEE_READ,
  PERMISSIONS.DOCUMENT_READ,
  PERMISSIONS.DOCUMENT_PREVIEW,
  PERMISSIONS.SIGNATURE_READ,
  PERMISSIONS.DOCUMENT_TYPE_READ,
  PERMISSIONS.REPORT_READ,
]

const ADMIN_PERMISSIONS: readonly Permission[] = [
  ...HR_PERMISSIONS,
  PERMISSIONS.USER_MANAGE,
]

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  [ROLES.HR]: HR_PERMISSIONS,
  [ROLES.VIEWER]: VIEWER_PERMISSIONS,
  [ROLES.ADMIN]: ADMIN_PERMISSIONS,
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false
}
