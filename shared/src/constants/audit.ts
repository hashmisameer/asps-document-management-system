/**
 * Auditable actions (Section 48).
 * Values are stored verbatim in dbo.AuditLogs.Action.
 */
export const AUDIT_ACTIONS = {
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  /** A user changing their own password. Every other session is revoked with it. */
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',

  EMPLOYEE_CREATED: 'EMPLOYEE_CREATED',
  EMPLOYEE_UPDATED: 'EMPLOYEE_UPDATED',
  EMPLOYEE_ARCHIVED: 'EMPLOYEE_ARCHIVED',
  EMPLOYEE_RESTORED: 'EMPLOYEE_RESTORED',

  DOCUMENT_UPLOADED: 'DOCUMENT_UPLOADED',
  DOCUMENT_REPLACED: 'DOCUMENT_REPLACED',
  DOCUMENT_VIEWED: 'DOCUMENT_VIEWED',
  DOCUMENT_DOWNLOADED: 'DOCUMENT_DOWNLOADED',
  DOCUMENT_VERIFIED: 'DOCUMENT_VERIFIED',
  DOCUMENT_REJECTED: 'DOCUMENT_REJECTED',
  DOCUMENT_ARCHIVED: 'DOCUMENT_ARCHIVED',
  /** An upload the identity check refused, accepted anyway with a reason. */
  DOCUMENT_IDENTITY_OVERRIDDEN: 'DOCUMENT_IDENTITY_OVERRIDDEN',
  /** An upload the identity check refused, and which was not overridden. */
  DOCUMENT_IDENTITY_REFUSED: 'DOCUMENT_IDENTITY_REFUSED',
  DEADLINE_CHANGED: 'DEADLINE_CHANGED',
  /** A pending-documents digest was emailed, and to how many addresses. */
  REMINDER_SENT: 'REMINDER_SENT',

  SIGNATURE_UPLOADED: 'SIGNATURE_UPLOADED',
  SIGNATURE_REPLACED: 'SIGNATURE_REPLACED',
  SIGNATURE_DETECTION_RUN: 'SIGNATURE_DETECTION_RUN',
  SIGNATURE_ACCEPTED: 'SIGNATURE_ACCEPTED',
  SIGNATURE_ADJUSTED: 'SIGNATURE_ADJUSTED',
  SIGNATURE_PLACED_MANUALLY: 'SIGNATURE_PLACED_MANUALLY',
  SIGNATURE_REMOVED: 'SIGNATURE_REMOVED',
  SIGNATURE_SKIPPED: 'SIGNATURE_SKIPPED',
  PROCESSED_PDF_GENERATED: 'PROCESSED_PDF_GENERATED',

  DOCUMENT_TYPE_CREATED: 'DOCUMENT_TYPE_CREATED',
  DOCUMENT_TYPE_UPDATED: 'DOCUMENT_TYPE_UPDATED',
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  /** An administrator resetting someone else's password, not a self-service change. */
  USER_PASSWORD_RESET: 'USER_PASSWORD_RESET',
  USER_DEACTIVATED: 'USER_DEACTIVATED',
  USER_REACTIVATED: 'USER_REACTIVATED',
  /** An HR or Admin user enrolling or re-drawing their own authorising signature. */
  USER_SIGNATURE_SAVED: 'USER_SIGNATURE_SAVED',
} as const

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]

export const AUDIT_ENTITY_TYPES = {
  USER: 'User',
  EMPLOYEE: 'Employee',
  DOCUMENT: 'EmployeeDocument',
  DOCUMENT_TYPE: 'DocumentType',
  SIGNATURE: 'EmployeeSignature',
  USER_SIGNATURE: 'UserSignature',
  SIGNATURE_PLACEMENT: 'SignaturePlacement',
  REMINDER: 'Reminder',
} as const

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[keyof typeof AUDIT_ENTITY_TYPES]

/**
 * Keys that must NEVER appear in AuditLogs.Metadata or application logs
 * (Section 59). The audit service strips these before insert.
 */
export const AUDIT_REDACTED_KEYS: readonly string[] = [
  'password',
  'passwordHash',
  'passwordSalt',
  'currentPassword',
  'newPassword',
  'token',
  'tokenHash',
  'sessionToken',
  'cookie',
  'authorization',
  'connectionString',
  'dbPassword',
  'secret',
  'apiKey',
  'fileBuffer',
  'fileContent',
  // Identity numbers. The record holds them because the service card check
  // compares them, but nothing is served by a copy of them in a log line or in
  // audit metadata, where they would outlive the record and be read by anyone
  // who can read the trail.
  'aadhaarNumber',
  'panNumber',
  'uanNumber',
  'esiNumber',
]
