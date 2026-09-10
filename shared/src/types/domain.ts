import type { Role } from '../constants/roles.js'
import type { DocumentStatus, Gender, SignatureStatus, SignerRole } from '../constants/documents.js'
import type { DeadlineState, DeadlineUnit } from '../constants/deadlines.js'
import type { DocumentField, FieldCheckResult, TextSource } from '../constants/documentFields.js'
import type { EmploymentStatus, ExitReason } from '../constants/employment.js'

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
  email: string | null
  address: string | null
  dateOfBirth: string | null
  gender: Gender | null
  postAppliedFor: string | null
  categoryOfWorkmen: string | null
  aadhaarNumber: string | null
  panNumber: string | null
  uanNumber: string | null
  esiNumber: string | null
  appointmentLetterDate: string | null

  /** True once a photograph has been uploaded. The image itself is served by an
      authenticated route, never embedded in this payload. */
  hasPhoto: boolean
  photoUpdatedAt: string | null

  /**
   * Whether they still work here, and the exit if they do not.
   *
   * Separate from `isActive`, which is the archive flag. Somebody who has left
   * is normally NOT archived: their provident fund and gratuity records have to
   * be produced for years afterwards, so the record stays in plain view.
   *
   * The status turns to LEFT only once the last working date has passed. Between
   * resigning and that date they are still employed - still paid, still on the
   * checklist - which is why the two dates are recorded separately.
   */
  employmentStatus: EmploymentStatus
  resignationDate: string | null
  lastWorkingDate: string | null
  exitReason: ExitReason | null
  exitNotes: string | null

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
  /**
   * Phrases that identify a document AS this type; one is enough. Empty means
   * the type is not recognised, which is not the same as recognised and wrong.
   */
  recognitionKeywords: string[]
  /**
   * A document of this type is NOT kept when the check refuses it.
   *
   * The reading happens after the file is stored, so 'do not upload it' has to
   * mean 'take it back off again'. Set for the two identity cards, where a name
   * that does not match means the wrong person's card; everywhere else a failed
   * check stays on the record for somebody to look at.
   */
  refuseOnCheckFailure: boolean
  /**
   * Needed in hand BEFORE the employee record can be created.
   *
   * Not the same as `isMandatory`, which says the document must be collected -
   * chased, counted, allowed to go overdue. This says the record cannot exist
   * without it. The two were one flag, so the Aadhaar and PAN cards being
   * mandatory also meant nobody could be entered without them, which was never
   * the office's rule.
   */
  requiredAtCreation: boolean
  /**
   * Whether HR may set this document aside for one employee.
   *
   * ESIC does not apply to everybody, so it may. PAN, Form 16 and the
   * appointment letter are statutory: nobody at this company decides they do
   * not apply to somebody, and a mis-click on one of those rows would take a
   * document off an employee's file and out of every count.
   *
   * Data rather than code, like refuseOnCheckFailure beside it: which documents
   * these are is an office decision about paperwork, and the next one should be
   * an UPDATE rather than a deployment.
   */
  canBeMarkedNotRequired: boolean
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
  /** False when the document could not be tied to this employee - refuses the upload. */
  passed: boolean
  /**
   * At least one IDENTIFYING field - name, code, Aadhaar or PAN - was found.
   *
   * This is what actually decides an upload. A field that merely describes the
   * employment can be missing from a document that is unambiguously the right
   * person's, and reporting it is useful where refusing over it is not.
   */
  identityConfirmed: boolean
  source: TextSource
  checks: FieldCheck[]
  /** True when the document yielded no readable text at all. */
  unreadable: boolean
  /**
   * Whether the document reads as the TYPE it was filed as.
   *
   * null when the type carries no recognition keywords, or nothing could be
   * read - "not recognised" is a different answer from "recognised and wrong",
   * and only the second refuses anything.
   */
  typeRecognised: boolean | null
}

export interface DocumentIdentityCheck {
  /**
   * Where the reading has got to.
   *
   * 'Checking' means the file is safely stored and is being read now. Reading
   * takes between four and sixty seconds, and it used to happen inside the
   * upload request - whoever pressed Upload waited for the whole of it. The file
   * is stored first now, so the answer arrives afterwards and the row changes
   * under them.
   *
   * 'Failed' means the reading finished and the document did not match. It is a
   * question for a person, not a refusal: the document is already on file, and
   * whoever is holding it accepts it with a reason or replaces it.
   */
  status: 'Passed' | 'Overridden' | 'NotChecked' | 'Checking' | 'Failed'
  source: TextSource | null
  checks: FieldCheck[]
  checkedAt: string | null
  overriddenByName: string | null
  overrideReason: string | null
  /** Why it failed, in a sentence, ready to show. Only set when status is 'Failed'. */
  failureReason: string | null
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
  /**
   * Whether this document type may be set aside for one employee at all.
   *
   * Carried on the row like isMandatory beside it, so the checklist can offer
   * the option on an ESIC form and not on a PAN card without a second request.
   * The server checks it too - see setNotRequired; hiding a button is a
   * courtesy, not a control.
   */
  canBeMarkedNotRequired: boolean

  originalFileName: string | null
  fileSizeBytes: number | null
  mimeType: string | null
  pageCount: number | null
  hasProcessedFile: boolean

  status: DocumentStatus
  signatureStatus: SignatureStatus

  /**
   * When somebody decided this document is not required OF THIS EMPLOYEE.
   *
   * ESIC does not apply to everybody. Null - which is every row until somebody
   * says otherwise - means it is expected as usual.
   *
   * A document marked this way is not outstanding, not overdue, not chased and
   * not counted against the employee. It stays on their checklist, labelled, so
   * the decision reads as a decision rather than as a document nobody noticed.
   *
   * NOT a status. It is not a stage a document passes through on the way to
   * being filed; it says this document has no journey.
   */
  notRequiredAt: string | null
  /** Who decided. Null when it is expected as usual. */
  notRequiredByName: string | null

  dueDate: string | null
  /**
   * How the deadline was set - which is how it is counted back on screen.
   *
   * The confirmation letter is six MONTHS after joining and is read in months;
   * everything else is read in days. Carried on the row so the browser can say
   * either without a second request for the document type.
   *
   * Display only. It follows the type's CURRENT setting while the due date on
   * this row is the one that was written when the employee was created, so
   * changing a deadline in Settings changes how an existing row is phrased and
   * never when it falls due.
   */
  deadlineUnit: DeadlineUnit | null
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
