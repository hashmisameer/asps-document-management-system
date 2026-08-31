import { z } from 'zod'
import {
  booleanQueryParam,
  dateOnlySchema,
  optionalShortText,
  paginationQuerySchema,
} from './common.js'

/**
 * An identity number, as someone actually types it.
 *
 * Spaces and hyphens are stripped before the length is checked, because an
 * Aadhaar number is written '1234 5678 9012' on every form that carries one and
 * refusing that spelling teaches people to fight the form. What is stored is
 * the digits, so the check against a document compares like with like.
 */
const digitsOnly = (length: number, label: string) =>
  z
    .string()
    .trim()
    .transform((value) => value.replace(/[\s-]/g, ''))
    .refine((value) => value.length === 0 || new RegExp(`^\\d{${length}}$`).test(value), {
      message: `${label} must be ${length} digits`,
    })
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional()

/**
 * The employee details the company's forms carry.
 *
 * Every one is optional. They are checked against an uploaded document when the
 * document type asks for them, and a detail the office has not recorded is
 * reported as missing FROM THE RECORD rather than as a fault in the document -
 * so an incomplete employee record never looks like a bad scan.
 */
export const employeeIdentitySchema = z.object({
  phoneNumber: z
    .string()
    .trim()
    .transform((value) => value.replace(/[\s()-]/g, ''))
    .refine((value) => value.length === 0 || /^(\+91)?\d{10}$/.test(value), {
      message: 'Mobile number must be 10 digits',
    })
    .transform((value) => (value.length === 0 ? null : value.replace(/^\+91/, '')))
    .nullable()
    .optional(),
  dateOfBirth: dateOnlySchema.nullable().optional(),
  postAppliedFor: optionalShortText(100),
  categoryOfWorkmen: optionalShortText(100),
  aadhaarNumber: digitsOnly(12, 'Aadhaar number'),
  /** Five letters, four digits, one letter - the shape is fixed by the format. */
  panNumber: z
    .string()
    .trim()
    .toUpperCase()
    .refine((value) => value.length === 0 || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(value), {
      // asps-dms:allow-secret - an example of the format, shown to the person typing.
      message: 'PAN must be five letters, four digits and a letter, such as ABCDE1234F',
    })
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional(),
  uanNumber: digitsOnly(12, 'UAN'),
  esiNumber: z
    .string()
    .trim()
    .transform((value) => value.replace(/[\s-]/g, ''))
    .refine((value) => value.length === 0 || /^\d{10,17}$/.test(value), {
      message: 'ESI number must be between 10 and 17 digits',
    })
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional(),
  appointmentLetterDate: dateOnlySchema.nullable().optional(),
})

/**
 * Employee creation.
 *
 * Business rules, Section 89 items 1-5, enforced identically here (browser)
 * and by the NOT NULL / NULL columns in dbo.Employees (server):
 *
 *   EmployeeCode  AUTO-GENERATED  - never accepted from the client
 *   EmployeeName  REQUIRED
 *   JoiningDate   REQUIRED
 *   Department    OPTIONAL
 *   Designation   OPTIONAL
 */
export const createEmployeeSchema = employeeIdentitySchema.extend({
  /**
   * The company's own employee number. REQUIRED.
   *
   * Typed rather than generated, because the identity check compares the code
   * ON THE DOCUMENT with the code on the record: a service card printed with
   * 4471 would never match a record filed as EMP003, and every upload for that
   * employee would need an override.
   *
   * Immutable once set (Section 13). Nothing edits it afterwards, so it is the
   * one field on this form worth reading twice before saving.
   */
  employeeCode: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, 'Employee ID is required')
    .max(20, 'Employee ID must be 20 characters or fewer')
    .regex(
      /^[A-Z0-9][A-Z0-9/_-]*$/,
      'Employee ID may use letters, digits, a slash, a dash or an underscore',
    ),
  employeeName: z
    .string()
    .trim()
    .min(1, 'Employee name is required')
    .max(150, 'Employee name must be 150 characters or fewer'),
  joiningDate: dateOnlySchema,
  department: optionalShortText(100),
  designation: optionalShortText(100),
})

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>

/**
 * Employee update. EmployeeCode is absent by design: it is immutable after
 * creation (Section 11) and there is no route that can change it.
 */
export const updateEmployeeSchema = createEmployeeSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'At least one field must be provided' },
)

export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>

/**
 * The columns a caller may sort the employee list by.
 *
 * An enum rather than a free string: `sortBy` reaches an ORDER BY clause, and
 * the only safe way to put a caller's value there is to accept nothing that is
 * not on this list. The backend maps each key to a column name; nothing the
 * caller sends is ever concatenated into SQL.
 */
export const EMPLOYEE_SORT_KEYS = [
  'employeeCode',
  'employeeName',
  'joiningDate',
  'department',
  'designation',
  'createdAt',
] as const

export type EmployeeSortKey = (typeof EMPLOYEE_SORT_KEYS)[number]

export const employeeListQuerySchema = paginationQuerySchema.extend({
  department: z.string().trim().max(100).optional(),
  designation: z.string().trim().max(100).optional(),
  /** Archived employees are hidden by default; they are never deleted. */
  includeArchived: booleanQueryParam.default(false),
  sortBy: z.enum(EMPLOYEE_SORT_KEYS).default('employeeName'),
})

export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>
