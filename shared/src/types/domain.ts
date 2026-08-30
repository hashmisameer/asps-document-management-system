import type { Role } from '../constants/roles.js'
import type { DocumentStatus, SignatureStatus } from '../constants/documents.js'
import type { DeadlineState, DeadlineUnit } from '../constants/deadlines.js'

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

export interface Employee {
  employeeId: number
  employeeCode: string
  employeeName: string
  joiningDate: string
  department: string | null
  designation: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface EmployeeDocumentCounts {
  total: number
  completed: number
  pending: number
  overdue: number
  signatureReviewRequired: number
}

export interface EmployeeListItem extends Employee {
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
  createdAt: string
  updatedAt: string
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
