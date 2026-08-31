import type { Role } from '../constants/roles.js'
import type { DocumentStatus, SignatureStatus, SignerRole } from '../constants/documents.js'
import type { DeadlineState, DeadlineUnit } from '../constants/deadlines.js'
import type { DocumentField, FieldCheckResult, TextSource } from '../constants/documentFields.js'

/**
 * API-facing domain shapes.
 *
 * All timestamps are ISO-8601 UTC strings. Date-only values (JoiningDate,
 * DueDate) are 'YYYY-MM-DD' with no time component, so they are never shifted
 * by a timezone conversion.
 */

export interface AuthUser {
  userId: number
  username: string
  fullName: string
  role: Role
  mustChangePassword: boolean
}

/**
 * A user account as an administrator sees it.
 *
 * No hash, no salt and no algorithm: those never leave the repository layer,
 * because there is no screen that has any use for them.
 */
export interface UserAccount {
  userId: number
  username: string
  fullName: string
  role: Role
  isActive: boolean
  mustChangePassword: boolean
  lastLoginAt: string | null
  /** Present only while a temporary lock is in force. */
  lockedUntil: string | null
  createdAt: string
  updatedAt: string
}

export interface Employee {
  employeeId: number
  employeeCode: string
  employeeName: string
  joiningDate: string
  department: string | null
  designation: string | null

  /**
   * The details the company's forms carry, and therefore the details an
   * uploaded document is checked against. All optional: an employee already on
   * file predates them, and a detail the office has not recorded is reported as
   * exactly that rather than as a document at fault.
   *
   * Aadhaar and PAN are the most sensitive values here. They are never included
   * in a list response, never logged, and never written to audit metadata.
   */
  phoneNumber: string | null
  dateOfBirth: string | null
  postAppliedFor: string | null
  categoryOfWorkmen: string | null
  aadhaarNumber: string | null
  panNumber: string | null
  uanNumber: string | null
  esiNumber: string | null
  appointmentLetterDate: string | null

  isActive: boolean
  createdAt: string
  updatedAt: string
}

/**
 * The employee as a LIST row.
 *
 * Omits the identity numbers on purpose: a list is the one place they would be
 * on screen in bulk, and nothing on a list has any use for them.
 */
export type EmployeeSummary = Omit<
  Employee,
  'aadhaarNumber' | 'panNumber' | 'uanNumber' | 'esiNumber'
>

export interface EmployeeDocumentCounts {
  total: number
  completed: number
  pending: number
  overdue: number
  signatureReviewRequired: number
}

export interface EmployeeListItem extends EmployeeSummary {
  counts: EmployeeDocumentCounts
}

export interface EmployeeProfile extends Employee {
  counts: EmployeeDocumentCounts
  hasSignature: boolean
  signatureUpdatedAt: string | null
}

export interface DocumentType {
  documentTypeId: number
  documentName: string
  documentCode: string
  isMandatory: boolean
  isActive: boolean
  requiresSignature: boolean
  deadlineValue: number | null
  deadlineUnit: DeadlineUnit | null
  sortOrder: number
  /**
   * Which of the employee's details this document must confirm before it can be
   * uploaded. Empty means the type is not checked.
   */
  requiredFields: DocumentField[]
  createdAt: string
  updatedAt: string
}

/** One field's outcome from reading a document and comparing it with the record. */
export interface FieldCheck {
  field: DocumentField
  result: FieldCheckResult
  /**
   * What the record says, for the fields it is safe to echo back. Null for
   * Aadhaar and PAN: showing the expected value beside a failure would turn a
   * refusal message into a way of reading an employee's identity numbers.
   */
  expected: string | null
}

export interface IdentityCheck {
  /** False when any required field was not confirmed - which refuses the upload. */
  passed: boolean
  source: TextSource
  checks: FieldCheck[]
  /** True when the document yielded no readable text at all. */
  unreadable: boolean
}

export interface DocumentIdentityCheck {
  status: 'Passed' | 'Overridden' | 'NotChecked'
  source: TextSource | null
  checks: FieldCheck[]
  checkedAt: string | null
  overriddenByName: string | null
  overrideReason: string | null
}

export interface EmployeeDocument {
  documentId: number
  employeeId: number
  employeeCode: string
  employeeName: string
  documentTypeId: number
  documentName: string
  isMandatory: boolean
  requiresSignature: boolean

  originalFileName: string | null
  fileSizeBytes: number | null
  mimeType: string | null
  pageCount: number | null
  hasProcessedFile: boolean

  status: DocumentStatus
  signatureStatus: SignatureStatus

  dueDate: string | null
  deadlineState: DeadlineState
  /** Positive = days remaining. Negative = days overdue. Null = no deadline. */
  daysRemaining: number | null

  /** What reading this document found, and any recorded override of a failure. */
  identityCheck: DocumentIdentityCheck | null

  uploadedByName: string | null
  uploadedAt: string | null
  verifiedByName: string | null
  verifiedAt: string | null
  rejectionReason: string | null

  createdAt: string
  updatedAt: string
}

/**
 * A signature placement.
 *
 * x / y / width / height are NORMALIZED to 0..1 against the page's UNROTATED
 * MediaBox, with a TOP-LEFT origin. Nothing about zoom level, screen DPI or
 * render scale is ever stored. See docs/coordinate-system.md.
 */
export interface SignaturePlacement {
  signaturePlacementId: number
  documentId: number
  employeeId: number
  pageNumber: number
  x: number
  y: number
  width: number
  height: number
  pageRotation: number
  method: PlacementMethod
  detectionMethod: DetectionMethod
  confidence: number | null
  /** Whose signature belongs in this box - the employee's, or the authoriser's. */
  signerRole: SignerRole
  /** For an Authoriser box, the user whose signature was drawn into it. */
  signerUserId: number | null
  signerName: string | null
  isApplied: boolean
  createdAt: string
  updatedAt: string
}

export type PlacementMethod = 'Automatic' | 'Manual' | 'Adjusted'
export type DetectionMethod = 'OCR' | 'CV' | 'Combined' | 'Manual'

/** A candidate returned by the detection engine. Advisory only, never applied. */
export interface DetectionCandidate {
  pageNumber: number
  x: number
  y: number
  width: number
  height: number
  pageRotation: number
  confidence: number
  detectionMethod: DetectionMethod
  /** e.g. the OCR phrase that anchored this candidate, shown to HR for context. */
  evidence?: string
}

export interface DetectionResult {
  documentId: number
  pageCount: number
  candidates: DetectionCandidate[]
  /** True when detection ran but found nothing, or failed. Never blocks HR. */
  detectionFailed: boolean
  failureReason?: string
  ranAt: string
}

export interface AuditLogEntry {
  auditLogId: number
  userId: number | null
  userName: string | null
  action: string
  entityType: string
  entityId: string | null
  ipAddress: string | null
  metadata: Record<string, unknown> | null
  timestamp: string
}

export interface DashboardSummary {
  totalEmployees: number
  totalDocuments: number
  completedDocuments: number
  pendingDocuments: number
  overdueDocuments: number
  signatureReviewRequired: number
  documentsUnderReview: number
}

/** Standard paginated envelope used by every list endpoint. */
export interface Paginated<T> {
  items: T[]
  page: number
  pageSize: number
  totalCount: number
  totalPages: number
}

/** Standard error envelope. Stack traces never cross this boundary. */
export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
    /** Correlates the user-facing message with the server log entry. */
    referenceId?: string
  }
}
