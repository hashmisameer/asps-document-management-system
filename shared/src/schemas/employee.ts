import { z } from 'zod'
import {
  booleanQueryParam,
  dateOnlySchema,
  optionalShortText,
  paginationQuerySchema,
} from './common.js'

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
export const createEmployeeSchema = z.object({
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
