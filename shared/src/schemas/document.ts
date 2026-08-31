import { z } from 'zod'
import { booleanQueryParam, dateOnlySchema, paginationQuerySchema, shortText } from './common.js'
import { DEADLINE_UNITS } from '../constants/deadlines.js'
import { DEADLINE_STATE } from '../constants/deadlines.js'
import { DOCUMENT_STATUS, SIGNATURE_STATUS } from '../constants/documents.js'

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

export const documentListQuerySchema = paginationQuerySchema.extend({
  employeeId: z.coerce.number().int().positive().optional(),
  documentTypeId: z.coerce.number().int().positive().optional(),
  status: documentStatusEnum.optional(),
  signatureStatus: signatureStatusEnum.optional(),
  deadlineState: deadlineStateEnum.optional(),
  mandatory: z.enum(['mandatory', 'optional']).optional(),
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
})

export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>

export const rejectDocumentSchema = z.object({
  reason: z.string().trim().min(1, 'A rejection reason is required').max(500),
})

export const updateDeadlineSchema = z.object({
  dueDate: dateOnlySchema.nullable(),
  reason: shortText(500).optional(),
})

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

export const updateDocumentTypeSchema = createDocumentTypeSchema
  .innerType()
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' })

export type UpdateDocumentTypeInput = z.infer<typeof updateDocumentTypeSchema>
