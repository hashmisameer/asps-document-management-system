import type {
  AuthUser,
  EmployeeImportPreview,
  EmployeeImportRefusal,
  EmployeeImportResult,
  EmployeeImportRow,
  ImportDateFormat,
} from '@asps-dms/shared'
import * as employeeRepository from '../repositories/employee.repository.js'
import { BadRequestError, describeError } from '../utils/errors.js'
import { readXlsx } from '../utils/xlsx.js'
import * as employeeService from './employee.service.js'
import { planImport, readRowsByPosition, type RowPlan } from './employeeImport.service.js'
import type { RequestContext } from './auth.service.js'

/**
 * The import screen: a spreadsheet previewed, then created row by row.
 *
 * employeeImport.service.ts judges the rows and is pure. This is the part that
 * touches the database, and it does two things only: reads the codes already
 * there so the plan can skip them, and calls employee.service.create for each
 * row the plan says to create - the same call the Add Employee form makes, so
 * an imported employee gets exactly the checklist a typed one gets and nothing
 * else. Nothing here reads or writes a document.
 *
 * The preview and the commit each take the file afresh. Nothing is kept on the
 * server between the two, so there is nothing to expire or lose, and the commit
 * is always planned against the database as it is at that moment - which is
 * what makes importing the same file twice create nothing the second time.
 */

/** A zip's first four bytes, which every .xlsx starts with. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

/**
 * The rows of an uploaded .xlsx, read by position.
 *
 * Checked by its bytes rather than its name: a .csv renamed .xlsx would
 * otherwise reach the zip reader and fail with a message about archives.
 */
export function readUpload(file: { originalname: string; buffer: Buffer }) {
  if (file.buffer.byteLength === 0) throw new BadRequestError('That file is empty.')
  if (!file.buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw new BadRequestError(
      'That is not an .xlsx file. Save the sheet as an Excel Workbook (.xlsx) and try again.',
    )
  }

  let table: string[][]
  try {
    table = readXlsx(file.buffer)
  } catch (error) {
    throw new BadRequestError(`That .xlsx could not be read: ${describeError(error)}`, {
      cause: error,
    })
  }

  return readRowsByPosition(table)
}

function toRow(plan: RowPlan, outcome: EmployeeImportRow['outcome']): EmployeeImportRow {
  const row: EmployeeImportRow = {
    line: plan.line,
    cells: plan.cells,
    employeeCode: plan.employeeCode,
    employeeName: plan.employeeName,
    outcome,
    errors: plan.errors,
    warnings: plan.warnings,
  }
  if (plan.paddedFrom !== undefined) row.paddedFrom = plan.paddedFrom
  if (plan.duplicate !== undefined) row.duplicate = plan.duplicate
  return row
}

/**
 * The file as the plan sees it, and what confirming would do. Writes nothing.
 *
 * The first joining date is echoed back as typed and as understood, because
 * '07/09/2026' is the 7th of September or the 9th of July depending on a
 * choice, and getting that wrong moves every deadline in the company.
 */
export async function preview(
  file: { originalname: string; buffer: Buffer },
  dateFormat: ImportDateFormat,
): Promise<EmployeeImportPreview> {
  const { header, rows } = readUpload(file)
  const existingCodes = await employeeRepository.allEmployeeCodes()
  const plan = planImport(rows, existingCodes, { format: dateFormat })

  const first = rows[0]
  const firstDate = first
    ? { text: first.values.joining_date ?? '', iso: plan.rows[0]?.input?.joiningDate ?? null }
    : null

  return {
    header,
    firstRow: first?.cells ?? [],
    dateFormat,
    firstDate,
    totals: {
      read: rows.length,
      create: plan.create.length,
      skip: plan.skip.length,
      fail: plan.fail.length,
      padded: plan.rows.filter((row) => row.paddedFrom !== undefined).length,
    },
    rows: plan.rows.map((row) =>
      toRow(row, row.errors.length > 0 ? 'fail' : row.duplicate ? 'skip' : 'create'),
    ),
  }
}

/**
 * Creates the rows the plan says to create, one at a time, and skips the rest.
 *
 * ROW BY ROW, NOT ONE TRANSACTION. Each employee and their checklist are one
 * transaction inside employee.service.create; the thirty rows are not. Three
 * bad rows must not undo twenty-seven good ones, and an import that stops
 * halfway leaves complete employees behind it and nothing half-made - running
 * the same file again finishes the job, because the ones already created are
 * skipped as duplicates.
 *
 * Created in the name of the person who pressed the button. There is no way
 * to import as somebody else.
 */
export async function commit(
  file: { originalname: string; buffer: Buffer },
  dateFormat: ImportDateFormat,
  actor: AuthUser,
  context: RequestContext,
): Promise<EmployeeImportResult> {
  const { rows } = readUpload(file)
  const existingCodes = await employeeRepository.allEmployeeCodes()
  const plan = planImport(rows, existingCodes, { format: dateFormat })

  let created = 0
  const refused: EmployeeImportRefusal[] = []

  for (const row of plan.create) {
    if (!row.input) continue
    try {
      await employeeService.create(row.input, actor, { ...context, userAgent: 'import' })
      created += 1
    } catch (error) {
      // One employee the database would not take does not stop the others.
      // The usual cause is a code somebody created by hand between the
      // preview and the confirm; the unique index is what says so.
      refused.push({
        line: row.line,
        cells: row.cells,
        employeeCode: row.employeeCode,
        reason: describeError(error),
      })
    }
  }

  return {
    created,
    skipped: plan.skip.length,
    failed: plan.fail.map((row) => toRow(row, 'fail')),
    refused,
  }
}
