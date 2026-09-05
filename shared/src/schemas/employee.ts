import { z } from 'zod'
import { GENDERS } from '../constants/documents.js'
import {
  ALL_EXIT_REASONS,
  EMPLOYEE_STATUS_FILTERS,
} from '../constants/employment.js'
import {
  booleanQueryParam,
  dateOnlySchema,
  idParamSchema,
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
  /**
   * Where the employee lives, as written on their forms.
   *
   * Free text and generous in length: an address on these forms runs to a
   * village, a district and a state, and refusing the way somebody writes their
   * own address teaches them to fight the form.
   */
  address: optionalShortText(500),
  /** Optional everywhere: most workmen here are reached by telephone. */
  email: z
    .string()
    .trim()
    .toLowerCase()
    .refine((value) => value.length === 0 || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value), {
      message: 'Enter a valid email address',
    })
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional(),
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
  gender: z.enum(GENDERS).nullable().optional(),
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
  /**
   * OPTIONAL, restored on 2026-09-03.
   *
   * They were briefly required. The office asked for that and then asked for it
   * back: a new employee is often entered from a single form that carries a
   * name, a code and a joining date, and refusing the record until somebody
   * invents a department teaches them to type something untrue.
   *
   * Only THREE things are genuinely required to create an employee - the code,
   * the name and the joining date - because those are what everything else
   * hangs off: documents are matched against the first two and every deadline
   * is computed from the third.
   */
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
  /* Not a column on the employee - it is counted from their checklist. Sorting
     by it puts the people with the most outstanding at the top, which is the
     order somebody chasing documents wants to read. */
  'documentsPending',
  'employeeCode',
  'employeeName',
  'joiningDate',
  'department',
  'designation',
  'createdAt',
] as const

export type EmployeeSortKey = (typeof EMPLOYEE_SORT_KEYS)[number]

/**
 * How far back to look at joining dates.
 *
 * A fixed list rather than two dates from the caller: 'who joined recently' is
 * the question the office actually asks, and a pair of free dates would need
 * validating, ordering and explaining to reach the same answer.
 */
export const JOINED_WITHIN_PERIODS = ['week', 'month', 'sixMonths', 'year'] as const

/**
 * Filtering by gender, including by its absence.
 *
 * 'notRecorded' is not a fourth gender - GENDERS has three and that is what the
 * record holds. It is the filter for employees nobody has recorded one for, who
 * are reported on the dashboard rather than quietly folded into a side.
 */
export const GENDER_FILTERS = [...GENDERS, 'notRecorded'] as const

export type GenderFilter = (typeof GENDER_FILTERS)[number]

export type JoinedWithinPeriod = (typeof JOINED_WITHIN_PERIODS)[number]

export const employeeListQuerySchema = paginationQuerySchema.extend({
  department: z.string().trim().max(100).optional(),
  designation: z.string().trim().max(100).optional(),
  /** Archived employees are hidden by default; they are never deleted. */
  includeArchived: booleanQueryParam.default(false),
  /**
   * Which employees to list: those still here, those who have left, or both.
   *
   * Defaults to those still here, because that is who the day's work is about.
   * Nothing is hidden by it - 'all' and 'left' are one click away, and no filter
   * removes a row from the database.
   */
  status: z.enum([
    EMPLOYEE_STATUS_FILTERS.ACTIVE,
    EMPLOYEE_STATUS_FILTERS.LEFT,
    EMPLOYEE_STATUS_FILTERS.ALL,
  ]).default(EMPLOYEE_STATUS_FILTERS.ACTIVE),
  sortBy: z.enum(EMPLOYEE_SORT_KEYS).default('employeeName'),
  /** Absent means every employee, however long ago they joined. */
  joinedWithin: z.enum(JOINED_WITHIN_PERIODS).optional(),

  /*
   * The filters the dashboard tiles open the list with.
   *
   * Each one is the SAME predicate the tile counted, so a tile that says 5 and
   * a list that shows 4 is a bug rather than a difference of definition. They
   * are ordinary filters as well - nothing here is only reachable from a tile.
   */

  /** 'notRecorded' is the absence of a gender, which is a real answer here. */
  gender: z.enum(GENDER_FILTERS).optional(),
  /**
   * Employees missing at least one MANDATORY document.
   *
   * Mandatory means the two identity cards, so this is the 'Missing an ID card'
   * tile: somebody whose Aadhaar or PAN has never come in.
   */
  missingIdCard: booleanQueryParam.default(false),
  /** Employees who have never signed on the pad. */
  withoutSignature: booleanQueryParam.default(false),
  /**
   * Whether their checklist is finished.
   *
   * EVERY document on it counts, optional ones included - 'optional' says
   * whether a document must be chased, not whether it is on the list. The two
   * values partition the employees a filter would otherwise return, which is
   * what lets the dashboard's two cards add up to the number of active staff.
   */
  checklist: z.enum(['complete', 'incomplete']).optional(),
  /**
   * Of those who have gone, the ones who went THIS calendar year.
   *
   * Counted from the last working date rather than the resignation date: the
   * year somebody left is the year they stopped coming in.
   */
  leftThisYear: booleanQueryParam.default(false),
  /**
   * Archived records ONLY, rather than archived alongside the rest.
   *
   * Separate from includeArchived because they answer different questions -
   * 'show me everything' and 'show me the ones the office has finished with'.
   */
  archivedOnly: booleanQueryParam.default(false),
})

export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>

/**
 * Recording that an employee has left.
 *
 * The two dates are both required and are not the same question. Somebody
 * resigns on the 1st and works until the 30th; for those thirty days they are
 * still employed and still on the checklist. Ordering between them, and against
 * the joining date, is checked in the service where the joining date is known -
 * a schema cannot see it - and again by the database.
 */
export const markEmployeeLeftSchema = z.object({
  resignationDate: dateOnlySchema,
  lastWorkingDate: dateOnlySchema,
  exitReason: z.enum(ALL_EXIT_REASONS as [string, ...string[]]),
  /** Optional, and the place for anything the four reasons do not cover. */
  /**
   * Optional, and optional means null as well as absent.
   *
   * It was `.optional()` alone, which in zod accepts `undefined` and REFUSES
   * `null`. The dialog sends null for an empty box - the honest thing for a
   * field the person deliberately left blank - so leaving the notes empty made
   * the whole request fail validation, and marking somebody as left worked only
   * if you happened to type a note.
   */
  exitNotes: z
    .string()
    .trim()
    .max(1000)
    .nullish()
    .transform((value) => (value ? value : null)),
})

export type MarkEmployeeLeftInput = z.infer<typeof markEmployeeLeftSchema>

/**
 * How many forms one print may produce.
 *
 * A cap rather than no limit, because the whole selection is rendered into one
 * response: HR selecting a filtered list of four hundred people and waiting on
 * a request that builds four hundred pages is a request that looks broken long
 * before it finishes. A hundred is comfortably more than the twenty-odd a
 * department's worth of forms comes to, and the message says what to do.
 */
export const MAX_FORMS_PER_PRINT = 100

/**
 * The employees whose forms are wanted, in one PDF.
 *
 * A POST with a body rather than a list of ids in the query string: a hundred
 * ids is a URL long enough that a proxy may truncate it, and a truncated
 * selection prints the wrong people rather than failing.
 */
export const printEmployeeFormsSchema = z.object({
  employeeIds: z
    .array(idParamSchema)
    .min(1, 'Select at least one employee to print.')
    .max(MAX_FORMS_PER_PRINT, `Print at most ${MAX_FORMS_PER_PRINT} forms at a time.`),
})

export type PrintEmployeeFormsInput = z.infer<typeof printEmployeeFormsSchema>
