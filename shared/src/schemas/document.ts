import { z } from 'zod'
import { booleanQueryParam, dateOnlySchema, paginationQuerySchema, shortText } from './common.js'
import { DEADLINE_UNITS } from '../constants/deadlines.js'
import { DEADLINE_STATE } from '../constants/deadlines.js'
import { DOCUMENT_STATUS, SIGNATURE_STATUS } from '../constants/documents.js'
import { MIN_IDENTITY_OVERRIDE_REASON_LENGTH } from '../constants/documentFields.js'

const documentStatusEnum = z.enum([
  DOCUMENT_STATUS.PENDING,
  DOCUMENT_STATUS.UPLOADED,
  DOCUMENT_STATUS.UNDER_REVIEW,
  DOCUMENT_STATUS.VERIFIED,
  DOCUMENT_STATUS.REJECTED,
])

const signatureStatusEnum = z.enum([
  SIGNATURE_STATUS.NOT_REQUIRED,
  SIGNATURE_STATUS.PENDING_DETECTION,
  SIGNATURE_STATUS.REVIEW_REQUIRED,
  SIGNATURE_STATUS.ADDED,
  SIGNATURE_STATUS.SKIPPED,
])

const deadlineStateEnum = z.enum([
  DEADLINE_STATE.NOT_APPLICABLE,
  DEADLINE_STATE.COMPLETED,
  DEADLINE_STATE.NOT_DUE,
  DEADLINE_STATE.DUE_SOON,
  DEADLINE_STATE.DUE_TODAY,
  DEADLINE_STATE.OVERDUE,
])

/**
 * The document type list.
 *
 * Inactive types are hidden by default: a type that has been retired should not
 * appear in a filter or a form, but it still has to be readable, because
 * employees who joined earlier may hold documents against it.
 */
export const documentTypeListQuerySchema = z.object({
  includeInactive: booleanQueryParam.default(false),
})

export type DocumentTypeListQuery = z.infer<typeof documentTypeListQuerySchema>

/**
 * Which checklist rows a documents list is asking for.
 *
 * The dashboard's document tiles count ROWS, not people - 'Still to come 57' is
 * fifty-seven documents spread over however many employees - so the list they
 * open names an employee AND a document on every line. Opening an employee list
 * from those tiles would show a different number from the tile, every time.
 *
 * These five are deliberately not expressible as a combination of `status` and
 * `deadlineState` below. Each one is the EXACT predicate its dashboard tile
 * counts with, which is what makes the tile and the list agree:
 *
 *   received  a file is attached, whatever review it is at - even a rejected
 *             one, which arrived and is on the record
 *   pending   no file attached
 *   overdue   no file, and the due date has passed
 *   dueSoon   no file, and the due date falls within the next 7 days,
 *             INCLUDING today
 */
export const DOCUMENT_LIST_STATES = ['all', 'received', 'pending', 'overdue', 'dueSoon'] as const

export type DocumentListState = (typeof DOCUMENT_LIST_STATES)[number]

export const DOCUMENT_LIST_SORT_KEYS = [
  'employeeName',
  'employeeCode',
  'documentName',
  'dueDate',
  'department',
] as const

export type DocumentListSortKey = (typeof DOCUMENT_LIST_SORT_KEYS)[number]

export const documentListQuerySchema = paginationQuerySchema.extend({
  employeeId: z.coerce.number().int().positive().optional(),
  documentTypeId: z.coerce.number().int().positive().optional(),
  status: documentStatusEnum.optional(),
  signatureStatus: signatureStatusEnum.optional(),
  deadlineState: deadlineStateEnum.optional(),
  mandatory: z.enum(['mandatory', 'optional']).optional(),
  state: z.enum(DOCUMENT_LIST_STATES).default('all'),
  department: z.string().trim().max(100).optional(),
  sortBy: z.enum(DOCUMENT_LIST_SORT_KEYS).default('dueDate'),
  /** Oldest deadline first: the row waited on longest is read first. */
  sortDir: z.enum(['asc', 'desc']).default('asc'),
})

export type DocumentListQuery = z.infer<typeof documentListQuerySchema>

/**
 * Upload metadata accompanying the multipart file.
 *
 * `isExistingRecord` covers Section 19: documents that HR already holds as hard
 * copies for existing employees. Those are not awaiting employee submission, so
 * they carry no deadline and HR chooses the landing status directly.
 */
export const uploadDocumentSchema = z.object({
  isExistingRecord: booleanQueryParam.default(false),
  landingStatus: z
    .enum([DOCUMENT_STATUS.UPLOADED, DOCUMENT_STATUS.VERIFIED])
    .default(DOCUMENT_STATUS.UPLOADED),
  notes: shortText(500).optional(),
  /**
   * Accepts a document the identity check refused, and says why.
   *
   * A reason is REQUIRED to override, and it is written to the document row and
   * to the audit trail under the name of whoever sent it. That is the whole
   * point of the control: the check can always be gone around - a scan too poor
   * for OCR to read a digit is a real document - but going around it leaves a
   * mark that names a person.
   */
  identityOverrideReason: z
    .string()
    .trim()
    .min(
      MIN_IDENTITY_OVERRIDE_REASON_LENGTH,
      'Say why this document is being accepted, in a few words',
    )
    .max(500)
    .optional(),
})

export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>

export const rejectDocumentSchema = z.object({
  reason: z.string().trim().min(1, 'A rejection reason is required').max(500),
})

export type RejectDocumentInput = z.infer<typeof rejectDocumentSchema>

/**
 * A per-document deadline override.
 *
 * Null clears it. The deadline a document type carries is a default applied
 * when the checklist is created, not a rule: HR can extend one employee's
 * deadline without changing what every future joiner gets.
 */
export const updateDeadlineSchema = z.object({
  dueDate: dateOnlySchema.nullable(),
  reason: shortText(500).optional(),
})

export type UpdateDocumentDeadlineInput = z.infer<typeof updateDeadlineSchema>

export const createDocumentTypeSchema = z
  .object({
    documentName: z.string().trim().min(1, 'Document name is required').max(150),
    documentCode: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(/^[A-Z0-9_]+$/, 'Code may contain only A-Z, 0-9 and underscore'),
    isMandatory: z.boolean().default(false),
    isActive: z.boolean().default(true),
    requiresSignature: z.boolean().default(false),
    deadlineValue: z.number().int().min(0).max(3650).nullable().default(null),
    deadlineUnit: z.enum([DEADLINE_UNITS.DAY, DEADLINE_UNITS.MONTH]).nullable().default(null),
    sortOrder: z.number().int().min(0).max(9999).default(0),
  })
  .refine((v) => (v.deadlineValue === null) === (v.deadlineUnit === null), {
    message: 'Deadline value and unit must both be set, or both be empty',
    path: ['deadlineUnit'],
  })

export type CreateDocumentTypeInput = z.infer<typeof createDocumentTypeSchema>

/**
 * What Settings may change about a document type.
 *
 * Everything the office configures - whether a document is mandatory, how long
 * they have to bring it, whether it is on the list at all - so none of it is
 * hard-coded in the application. Every field is optional: a screen that toggles
 * one flag sends one flag, and a field left out is left alone rather than
 * blanked.
 *
 * NOT the code. A DocumentCode identifies the document for ever: the identity
 * cards are found by theirs, and every checklist row already written points at
 * it. The NAME can be corrected, because that is a label.
 *
 * Retiring a type - isActive false - is how a document added by mistake is
 * taken off the list. Nothing is deleted: the rows already created against it,
 * and any file uploaded to one, stay exactly where they are.
 */
export const updateDocumentTypeSchema = createDocumentTypeSchema
  .innerType()
  .omit({ documentCode: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' })
  .refine(
    (v) =>
      // A value without a unit is not a deadline, and a unit without a value is
      // not one either. The database has the same rule.
      v.deadlineValue === undefined ||
      v.deadlineUnit === undefined ||
      (v.deadlineValue === null) === (v.deadlineUnit === null),
    {
      message: 'A deadline needs both a number and a unit, or neither.',
      path: ['deadlineValue'],
    },
  )

export type UpdateDocumentTypeInput = z.infer<typeof updateDocumentTypeSchema>

/**
 * Accepting a document the check refused.
 *
 * Its own request now, rather than a field on the upload: the reading happens
 * after the file is stored, so by the time anyone can decide to accept a
 * refusal, the document is already there to be looked at.
 */
/**
 * Confirming a document by hand.
 *
 * The reason is OPTIONAL, and normally absent. Confirming is one button: these
 * are photocopies, OCR failing to read a name off one is the ordinary case, and
 * a required sentence would be the same sentence 550 times. Where none is sent
 * the server records MANUAL_CONFIRMATION_REASON, which says a person confirmed
 * it and the machine did not.
 *
 * Still accepted where somebody has something to add, and still held to a
 * length that means something when they do.
 */
export const overrideIdentityCheckSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(
      MIN_IDENTITY_OVERRIDE_REASON_LENGTH,
      'Say why this document is being accepted, in a few words',
    )
    .max(500)
    .optional(),
})

export type OverrideIdentityCheckInput = z.infer<typeof overrideIdentityCheckSchema>

/**
 * Checking an identity document against a name that has only been typed.
 *
 * The name comes from the form rather than from a record, because on the Add
 * Employee screen there is no record yet - that is the whole reason this exists.
 */
export const previewIdentitySchema = z.object({
  employeeName: z.string().trim().min(1, 'Enter the employee name first'),
  documentName: z.string().trim().min(1).max(150),
})

export type PreviewIdentityInput = z.infer<typeof previewIdentitySchema>

/**
 * The employees behind one row of the by-document report.
 *
 * Paged on the server: 568 employees against ten document types is not a list
 * to send whole so a screen can show twenty-five of it.
 */
export const documentEmployeesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  /**
   * Outstanding only, by default.
   *
   * That is who HR is chasing, and it is also what makes this list agree with
   * the count on the row it was opened from.
   */
  outstandingOnly: booleanQueryParam.default(true),
  onlyOverdue: booleanQueryParam.default(false),
  department: z.string().trim().max(100).optional(),
  sortBy: z
    .enum(['employeeName', 'employeeCode', 'department', 'designation', 'dueDate', 'daysOverdue'])
    .default('daysOverdue'),
  /** Oldest overdue first: the person waited on longest is read first. */
  sortDir: z.enum(['asc', 'desc']).default('asc'),
})

export type DocumentEmployeesQuery = z.infer<typeof documentEmployeesQuerySchema>

/**
 * The same list, for printing.
 *
 * The filters and the sort, and deliberately NOT the paging: a printed chase
 * list holds every employee the filters match. Printing the twenty-five rows
 * that happen to be on screen is the mistake this omission exists to prevent -
 * it hands a department head a sheet that silently leaves the other sixteen
 * people off it.
 */
export const printDocumentEmployeesQuerySchema = documentEmployeesQuerySchema.omit({
  page: true,
  pageSize: true,
})

export type PrintDocumentEmployeesQuery = z.infer<typeof printDocumentEmployeesQuerySchema>
