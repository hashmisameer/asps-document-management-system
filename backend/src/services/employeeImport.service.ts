import path from 'node:path'
import { createEmployeeSchema, type CreateEmployeeInput } from '@asps-dms/shared'
import { readXlsx } from '../utils/xlsx.js'

/**
 * Reading an employee master out of a spreadsheet.
 *
 * Everything here is PURE - text in, a plan out - so the whole of it can be
 * tested against the real file the office exported without a database in
 * sight. The script that writes the rows is importEmployees.ts, and it does
 * nothing this file has not already checked.
 *
 * The rule that shapes it: a spreadsheet of 568 people will have something
 * wrong with it, and the wrong answer is to stop on row 12. Every row is
 * judged on its own and the ones that cannot be read are listed at the end,
 * with the row number, so somebody can fix those and run it again.
 */

/** The columns the template carries, in the office's own words. */
export const IMPORT_COLUMNS = [
  'employee_code',
  'full_name',
  'joining_date',
  'department',
  'designation',
  'mobile',
  'address',
  'employment_status',
  'is_existing_employee',
] as const

/**
 * How a date in the file is to be read.
 *
 * Excel writes what the machine's locale tells it to, and '4/11/2022' is the
 * 11th of April in one and the 4th of November in another. There is no way to
 * tell from the file, and getting it wrong moves every deadline in the
 * company - so it is a choice somebody makes, not a guess this makes for them.
 *
 * 'mdy' is the default because that is what the exports from this office have
 * been: '6/23/2023' can only be June.
 */
export type DateFormat = 'mdy' | 'dmy'

export interface ParsedRow {
  /** The line in the file, counting the header as line 1. */
  line: number
  values: Record<string, string>
}

export interface RowPlan {
  line: number
  employeeCode: string
  employeeName: string
  /** Present when the row can be created. */
  input?: CreateEmployeeInput
  /** Why the row cannot be created. Empty when it can. */
  errors: string[]
  /**
   * What was dropped to make the row usable.
   *
   * An optional detail that fails validation - a mobile number with eleven
   * digits - is left out and the employee is still created. Losing a person
   * from the master because somebody mistyped a phone number would be a worse
   * answer than importing them without it, and the warning says exactly what
   * was dropped so it can be corrected afterwards.
   *
   * `--strict` turns these into errors.
   */
  warnings: string[]
  /** The employee already exists, so this row does nothing. */
  duplicate?: 'in the database' | 'earlier in this file'
}

export interface ImportPlan {
  rows: RowPlan[]
  create: RowPlan[]
  skip: RowPlan[]
  fail: RowPlan[]
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A CSV reader, to the rules Excel actually writes.
 *
 * Quoted fields, commas and newlines inside them, and '""' for a quote. Written
 * here rather than pulled in as a dependency: it is thirty lines, the server
 * has no route to a registry, and every address in the office's file - 'A-106A
 * BASTI, R K PURAM NEW DELHI' - is a quoted field with a comma in it.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  // A byte-order mark from Excel would otherwise become part of the first
  // column's name, and no header would match.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  for (let i = 0; i < input.length; i += 1) {
    const character = input[i]

    if (quoted) {
      if (character === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += character
      }
      continue
    }

    if (character === '"') {
      quoted = true
    } else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (character !== '\r') {
      field += character
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

/** True for a line Excel leaves behind: every cell empty. */
function isBlank(row: string[]): boolean {
  return row.every((cell) => cell.trim() === '')
}

/**
 * A file as a rectangle of text, whichever kind it is.
 *
 * .xlsx and .csv, decided by the extension. Both end up as the same table of
 * strings, so everything below this line - the header, the validation, the
 * duplicate check - has no idea which it was reading.
 */
export function readTable(fileName: string, contents: Buffer): string[][] {
  const extension = path.extname(fileName).toLowerCase()

  if (extension === '.xlsx') return readXlsx(contents)
  if (extension === '.csv' || extension === '.txt') return parseCsv(contents.toString('utf8'))

  throw new Error(
    `'${extension || fileName}' is not a file this reads. Save the sheet as .xlsx or .csv.`,
  )
}

/**
 * The table as named rows.
 *
 * Header names are compared lower-cased and trimmed, so a column typed
 * 'Employee_Code' still matches. Blank lines are dropped - the office's export
 * ends with fifty of them.
 */
export function readRows(source: string | string[][]): {
  rows: ParsedRow[]
  missingColumns: string[]
} {
  const table = typeof source === 'string' ? parseCsv(source) : source
  const header = (table[0] ?? []).map((name) => name.trim().toLowerCase())

  const missingColumns = IMPORT_COLUMNS.filter((column) => !header.includes(column))
  if (missingColumns.length > 0) return { rows: [], missingColumns }

  const rows: ParsedRow[] = []
  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i] ?? []
    if (isBlank(cells)) continue

    const values: Record<string, string> = {}
    header.forEach((name, column) => {
      values[name] = (cells[column] ?? '').trim()
    })
    rows.push({ line: i + 1, values })
  }

  return { rows, missingColumns: [] }
}

/* -------------------------------------------------------------------------- */
/* Values                                                                      */
/* -------------------------------------------------------------------------- */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const SLASHED_DATE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/

/**
 * A date as Excel stores one: days since the 30th of December 1899.
 *
 * A cell formatted as a date holds a NUMBER, and the format that makes it look
 * like a date lives elsewhere in the file entirely. So a bare number in the
 * joining-date column is read as a serial - bounded to a sane range, 1970 to
 * 2079, so an employee code that wandered into the wrong column cannot quietly
 * become a date.
 *
 * The epoch is the 30th rather than the 31st because Excel believes 1900 was a
 * leap year. It was not, and that extra day is baked into every serial above
 * 60, so the offset absorbs it.
 */
function fromExcelSerial(serial: number): string | null {
  if (serial < 25569 || serial > 65380) return null

  const date = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/**
 * A date from the file as 'YYYY-MM-DD', or null if it is not one.
 *
 * Round-tripped through the calendar rather than range-checked, so 31/02/2026
 * is refused: it is four digits in the right places and it is not a day.
 */
export function parseImportDate(value: string, format: DateFormat): string | null {
  const text = value.trim()
  if (text === '') return null

  // A number on its own is Excel's own way of writing a date.
  if (/^[0-9]{4,5}$/.test(text)) return fromExcelSerial(Number(text))

  const iso = ISO_DATE.exec(text)
  const slashed = SLASHED_DATE.exec(text)

  let year: number
  let month: number
  let day: number

  if (iso) {
    year = Number(iso[1])
    month = Number(iso[2])
    day = Number(iso[3])
  } else if (slashed) {
    year = Number(slashed[3])
    month = Number(format === 'mdy' ? slashed[1] : slashed[2])
    day = Number(format === 'mdy' ? slashed[2] : slashed[1])
  } else {
    return null
  }

  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }

  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)}`
}

/**
 * Whether the code looks like Excel has eaten its leading zeros.
 *
 * The office's codes are eight digits - '00000068' - and a spreadsheet that
 * has read that column as a number writes '68'. The row still imports, because
 * the code may genuinely be short, but the warning is what stops 568 employees
 * being filed under the wrong numbers.
 */
export function looksTruncated(employeeCode: string): boolean {
  return /^\d+$/.test(employeeCode) && employeeCode.length < 8
}

/* -------------------------------------------------------------------------- */
/* The plan                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One row, read and judged.
 *
 * Validated with the SAME schema the API validates a typed form with, so the
 * import cannot create a record the application would have refused.
 */
export function planRow(row: ParsedRow, format: DateFormat): RowPlan {
  const value = (column: string): string => row.values[column] ?? ''

  const employeeCode = value('employee_code').toUpperCase()
  const employeeName = value('full_name')

  const plan: RowPlan = { line: row.line, employeeCode, employeeName, errors: [], warnings: [] }

  const joiningDate = parseImportDate(value('joining_date'), format)
  if (value('joining_date') === '') {
    plan.errors.push('joining_date is empty')
  } else if (joiningDate === null) {
    plan.errors.push(`joining_date '${value('joining_date')}' is not a date`)
  }

  /*
   * Only employees who are still here.
   *
   * Creating somebody and marking them as left is two steps, and the second
   * one needs dates this file does not carry - a resignation date and a last
   * working day. A LEFT row is reported rather than half-imported.
   */
  const status = value('employment_status').toUpperCase()
  if (status !== '' && status !== 'ACTIVE') {
    plan.errors.push(
      `employment_status is '${status}'. Import the active employees, then record the exits on their records.`,
    )
  }

  if (looksTruncated(employeeCode)) {
    plan.warnings.push(
      `employee_code '${employeeCode}' is shorter than the usual eight digits - check the spreadsheet has not dropped its leading zeros`,
    )
  }

  /*
   * The optional details are offered, and dropped one at a time if the schema
   * refuses them. `is_existing_employee` is read and deliberately not used:
   * the office asked for these employees to be treated exactly like any other,
   * so their deadlines run from their joining date like everybody else's.
   */
  const optional: Record<string, string> = {
    department: value('department'),
    designation: value('designation'),
    phoneNumber: value('mobile'),
    address: value('address'),
  }

  const candidate: Record<string, unknown> = {
    employeeCode,
    employeeName,
    joiningDate: joiningDate ?? '',
  }
  for (const [field, text] of Object.entries(optional)) {
    if (text !== '') candidate[field] = text
  }

  const parsed = createEmployeeSchema.safeParse(candidate)
  if (parsed.success) {
    // Only when nothing above has already refused the row: an employee who has
    // left parses perfectly well and still must not be created.
    if (plan.errors.length === 0) plan.input = parsed.data
    return plan
  }

  // Which of the failures are only about a detail that can be left out.
  const droppable = new Set(['department', 'designation', 'phoneNumber', 'address'])
  const retry = { ...candidate }
  let retryable = true

  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? '')
    if (droppable.has(field)) {
      plan.warnings.push(`${field} dropped: ${issue.message} (was '${String(retry[field] ?? '')}')`)
      delete retry[field]
    } else {
      // Already reported above for the date; anything else is said once here.
      if (field !== 'joiningDate' || plan.errors.length === 0) {
        plan.errors.push(`${field || 'row'}: ${issue.message}`)
      }
      retryable = false
    }
  }

  if (!retryable) return plan

  const second = createEmployeeSchema.safeParse(retry)
  if (!second.success) {
    plan.errors.push('the row could not be read even without its optional details')
  } else if (plan.errors.length === 0) {
    plan.input = second.data
  }

  return plan
}

/**
 * The whole file, judged against what is already in the database.
 *
 * Duplicates are settled here rather than by letting the insert fail, for two
 * reasons: a dry run must be able to report them without writing anything, and
 * running the import twice has to be safe. A code that appears twice in the
 * FILE is caught as well - the second one is not a new employee.
 */
export function planImport(
  rows: readonly ParsedRow[],
  existingCodes: ReadonlySet<string>,
  options: { format: DateFormat; strict?: boolean },
): ImportPlan {
  const seen = new Set<string>()
  const planned: RowPlan[] = []

  for (const row of rows) {
    const plan = planRow(row, options.format)

    if (options.strict && plan.warnings.length > 0) {
      plan.errors.push(...plan.warnings.map((warning) => `--strict: ${warning}`))
      plan.warnings.length = 0
      delete plan.input
    }

    if (plan.errors.length === 0) {
      if (existingCodes.has(plan.employeeCode)) plan.duplicate = 'in the database'
      else if (seen.has(plan.employeeCode)) plan.duplicate = 'earlier in this file'
      else seen.add(plan.employeeCode)
    }

    planned.push(plan)
  }

  return {
    rows: planned,
    create: planned.filter((plan) => plan.errors.length === 0 && !plan.duplicate),
    skip: planned.filter((plan) => plan.duplicate !== undefined),
    fail: planned.filter((plan) => plan.errors.length > 0),
  }
}
