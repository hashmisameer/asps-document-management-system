import {
  DOCUMENT_STATUS,
  SIGNATURE_STATUS,
  formatDateOnly,
  parseDateOnly,
  todayDateOnly,
  type CreateEmployeeInput,
  type Employee,
  type EmployeeDocumentCounts,
  type EmployeeListItem,
  type EmployeeListQuery,
  type EmployeeProfile,
  type EmployeeSortKey,
  type Paginated,
  type UpdateEmployeeInput,
} from '@asps-dms/shared'
import { createRequest, sql } from '../database/pool.js'

/**
 * dbo.Employees access.
 *
 * Two things here are worth reading before changing anything:
 *
 *   1. Nothing a caller sends is ever concatenated into query text. Where a
 *      clause genuinely has to be built - an optional filter, a sort column -
 *      it is assembled from string LITERALS chosen by a whitelist, and every
 *      value still arrives as a bound parameter. scripts/check-sql-safety.mjs
 *      permits a named SQL fragment and fails the build on anything else.
 *   2. "Overdue" is derived, never stored (standing assumption 4). The counts
 *      below compare DueDate against a `today` passed in from Node, so the API
 *      and the database agree on which day it is instead of each consulting a
 *      different clock.
 */

interface EmployeeCountsRow {
  Total: number | null
  Completed: number | null
  Overdue: number | null
  SignatureReview: number | null
}

interface EmployeeRow extends EmployeeCountsRow {
  EmployeeId: number
  EmployeeCode: string
  EmployeeName: string
  JoiningDate: Date
  Department: string | null
  Designation: string | null
  PhoneNumber: string | null
  DateOfBirth: Date | null
  PostAppliedFor: string | null
  CategoryOfWorkmen: string | null
  AadhaarNumber: string | null
  PanNumber: string | null
  UanNumber: string | null
  EsiNumber: string | null
  AppointmentLetterDate: Date | null
  IsActive: boolean
  CreatedAt: Date
  UpdatedAt: Date
}

interface EmployeeProfileRow extends EmployeeRow {
  SignatureUpdatedAt: Date | null
}

const SELECT_EMPLOYEE_COLUMNS = `
             e.EmployeeId, e.EmployeeCode, e.EmployeeName, e.JoiningDate,
             e.Department, e.Designation, e.PhoneNumber, e.DateOfBirth,
             e.PostAppliedFor, e.CategoryOfWorkmen, e.AadhaarNumber, e.PanNumber,
             e.UanNumber, e.EsiNumber, e.AppointmentLetterDate,
             e.IsActive, e.CreatedAt, e.UpdatedAt`

/**
 * The same columns without the identity numbers, for the list.
 *
 * A list is the one screen that would put Aadhaar and PAN numbers on screen in
 * bulk, and nothing on it has any use for them.
 */
const SELECT_EMPLOYEE_LIST_COLUMNS = `
             e.EmployeeId, e.EmployeeCode, e.EmployeeName, e.JoiningDate,
             e.Department, e.Designation, e.PhoneNumber, e.DateOfBirth,
             e.PostAppliedFor, e.CategoryOfWorkmen,
             CAST(NULL AS VARCHAR(20)) AS AadhaarNumber,
             CAST(NULL AS VARCHAR(10)) AS PanNumber,
             CAST(NULL AS VARCHAR(20)) AS UanNumber,
             CAST(NULL AS VARCHAR(25)) AS EsiNumber,
             e.AppointmentLetterDate,
             e.IsActive, e.CreatedAt, e.UpdatedAt`

/**
 * The checklist counters, as a correlated subquery.
 *
 * OUTER APPLY rather than a GROUP BY join, so an employee with no documents yet
 * still comes back - with zeroes - instead of dropping out of the list.
 */
const COUNTS_APPLY = `
      OUTER APPLY (
          SELECT  COUNT(*) AS Total,
                  SUM(CASE WHEN d.Status IN (@stUploaded, @stUnderReview, @stVerified)
                           THEN 1 ELSE 0 END) AS Completed,
                  SUM(CASE WHEN d.Status NOT IN (@stUploaded, @stUnderReview, @stVerified)
                            AND d.DueDate IS NOT NULL
                            AND d.DueDate < @today
                           THEN 1 ELSE 0 END) AS Overdue,
                  SUM(CASE WHEN d.SignatureStatus = @sigReview THEN 1 ELSE 0 END) AS SignatureReview
          FROM    dbo.EmployeeDocuments AS d
          WHERE   d.EmployeeId = e.EmployeeId
            AND   d.IsActive = 1
      ) AS c`

/**
 * Binds the values the counters compare against.
 *
 * The status names live in shared/src/constants/documents.ts and reach SQL as
 * parameters, so what counts as "complete" cannot drift between these counts
 * and isDocumentComplete() in the shared rules.
 */
function bindCountParams(request: sql.Request, today: string): sql.Request {
  return request
    .input('stUploaded', sql.VarChar(20), DOCUMENT_STATUS.UPLOADED)
    .input('stUnderReview', sql.VarChar(20), DOCUMENT_STATUS.UNDER_REVIEW)
    .input('stVerified', sql.VarChar(20), DOCUMENT_STATUS.VERIFIED)
    .input('sigReview', sql.VarChar(20), SIGNATURE_STATUS.REVIEW_REQUIRED)
    .input('today', sql.Date, parseDateOnly(today))
}

function toCounts(row: EmployeeCountsRow): EmployeeDocumentCounts {
  // COUNT(*) over no rows is 0, but SUM over no rows is NULL.
  const total = row.Total ?? 0
  const completed = row.Completed ?? 0
  return {
    total,
    completed,
    pending: total - completed,
    overdue: row.Overdue ?? 0,
    signatureReviewRequired: row.SignatureReview ?? 0,
  }
}

function toEmployee(row: EmployeeRow): Employee {
  return {
    employeeId: row.EmployeeId,
    employeeCode: row.EmployeeCode,
    employeeName: row.EmployeeName,
    // A DATE column arrives as a UTC-midnight Date; formatting it by its UTC
    // components is what stops a joining date sliding by a day.
    joiningDate: formatDateOnly(row.JoiningDate),
    department: row.Department,
    designation: row.Designation,
    phoneNumber: row.PhoneNumber,
    dateOfBirth: row.DateOfBirth === null ? null : formatDateOnly(row.DateOfBirth),
    postAppliedFor: row.PostAppliedFor,
    categoryOfWorkmen: row.CategoryOfWorkmen,
    aadhaarNumber: row.AadhaarNumber,
    panNumber: row.PanNumber,
    uanNumber: row.UanNumber,
    esiNumber: row.EsiNumber,
    appointmentLetterDate:
      row.AppointmentLetterDate === null ? null : formatDateOnly(row.AppointmentLetterDate),
    isActive: row.IsActive,
    createdAt: row.CreatedAt.toISOString(),
    updatedAt: row.UpdatedAt.toISOString(),
  }
}

/**
 * Escapes the wildcards LIKE would otherwise read as syntax.
 *
 * Without this, a search for '100%' matches every employee and a stray '['
 * opens a character class that swallows the rest of the term. Only the three
 * pattern characters and the escape character itself are escaped: ']' outside a
 * class is already a literal, and escaping characters that are not special is
 * not something to rely on. The escape character is declared with ESCAPE in the
 * clause itself.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_[]/g, (character) => `\\${character}`)
}

/** sortBy keys -> columns. The enum in the shared schema is the only way in. */
const SORT_COLUMNS: Readonly<Record<EmployeeSortKey, string>> = {
  employeeCode: 'e.EmployeeCode',
  employeeName: 'e.EmployeeName',
  joiningDate: 'e.JoiningDate',
  department: 'e.Department',
  designation: 'e.Designation',
  createdAt: 'e.CreatedAt',
}

export async function list(query: EmployeeListQuery): Promise<Paginated<EmployeeListItem>> {
  const request = bindCountParams(await createRequest(), todayDateOnly())
  const conditions: string[] = []

  if (!query.includeArchived) conditions.push('e.IsActive = 1')

  if (query.department) {
    conditions.push('e.Department = @department')
    request.input('department', sql.NVarChar(100), query.department)
  }
  if (query.designation) {
    conditions.push('e.Designation = @designation')
    request.input('designation', sql.NVarChar(100), query.designation)
  }
  if (query.search) {
    conditions.push(
      "(e.EmployeeName LIKE @search ESCAPE '\\' OR e.EmployeeCode LIKE @search ESCAPE '\\'" +
        " OR e.Department LIKE @search ESCAPE '\\' OR e.Designation LIKE @search ESCAPE '\\')",
    )
    request.input('search', sql.NVarChar(210), `%${escapeLike(query.search)}%`)
  }

  // Literals only: every condition above is a fixed string naming a parameter,
  // never a caller's value.
  const WHERE_CLAUSE = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const DIRECTION = query.sortDir === 'desc' ? 'DESC' : 'ASC'
  // EmployeeId breaks ties so paging is stable: without it, two rows that sort
  // equally can appear on two pages, or on none.
  const ORDER_BY_CLAUSE = `${SORT_COLUMNS[query.sortBy]} ${DIRECTION}, e.EmployeeId ASC`

  request
    .input('offset', sql.Int, (query.page - 1) * query.pageSize)
    .input('pageSize', sql.Int, query.pageSize)

  // Two statements in one round trip, so the page and the total it reports
  // are read against the same state of the table.
  const result = await request.query<EmployeeRow>(`
      SELECT ${SELECT_EMPLOYEE_LIST_COLUMNS},
             c.Total, c.Completed, c.Overdue, c.SignatureReview
      FROM   dbo.Employees AS e
      ${COUNTS_APPLY}
      ${WHERE_CLAUSE}
      ORDER BY ${ORDER_BY_CLAUSE}
      OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;

      SELECT COUNT(*) AS TotalCount
      FROM   dbo.Employees AS e
      ${WHERE_CLAUSE};`)

  const countRecordset = result.recordsets[1] as unknown as { TotalCount: number }[] | undefined
  const totalCount = countRecordset?.[0]?.TotalCount ?? 0

  return {
    items: result.recordset.map((row) => ({ ...toEmployee(row), counts: toCounts(row) })),
    page: query.page,
    pageSize: query.pageSize,
    totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / query.pageSize)),
  }
}

export async function findById(employeeId: number): Promise<EmployeeProfile | null> {
  const request = bindCountParams(await createRequest(), todayDateOnly())

  const result = await request
    .input('employeeId', sql.Int, employeeId)
    .query<EmployeeProfileRow>(`
      SELECT ${SELECT_EMPLOYEE_COLUMNS},
             c.Total, c.Completed, c.Overdue, c.SignatureReview,
             s.UpdatedAt AS SignatureUpdatedAt
      FROM   dbo.Employees AS e
      ${COUNTS_APPLY}
      OUTER APPLY (
          SELECT TOP (1) es.UpdatedAt
          FROM   dbo.EmployeeSignatures AS es
          WHERE  es.EmployeeId = e.EmployeeId AND es.IsActive = 1
      ) AS s
      WHERE  e.EmployeeId = @employeeId`)

  const row = result.recordset[0]
  if (!row) return null

  return {
    ...toEmployee(row),
    counts: toCounts(row),
    hasSignature: row.SignatureUpdatedAt !== null,
    signatureUpdatedAt: row.SignatureUpdatedAt?.toISOString() ?? null,
  }
}

/**
 * Inserts an employee and returns the code that was generated for it.
 *
 * EmployeeCode is never accepted from the client (Sections 11 and 13): it comes
 * from dbo.EmployeeCodeSeq inside this statement, formatted EMP001..EMP999 and
 * then EMP1000 onwards so it keeps working past 999 without renumbering. The
 * UNIQUE constraint on the column is the final guarantee.
 */
export async function create(
  input: CreateEmployeeInput,
  createdBy: number,
  transaction?: sql.Transaction,
): Promise<{ employeeId: number; employeeCode: string }> {
  const request = await createRequest(transaction)
  const result = await request
    .input('employeeName', sql.NVarChar(150), input.employeeName)
    .input('joiningDate', sql.Date, parseDateOnly(input.joiningDate))
    .input('department', sql.NVarChar(100), input.department ?? null)
    .input('designation', sql.NVarChar(100), input.designation ?? null)
    .input('phoneNumber', sql.VarChar(20), input.phoneNumber ?? null)
    .input('dateOfBirth', sql.Date, input.dateOfBirth ? parseDateOnly(input.dateOfBirth) : null)
    .input('postAppliedFor', sql.NVarChar(100), input.postAppliedFor ?? null)
    .input('categoryOfWorkmen', sql.NVarChar(100), input.categoryOfWorkmen ?? null)
    .input('aadhaarNumber', sql.VarChar(20), input.aadhaarNumber ?? null)
    .input('panNumber', sql.VarChar(10), input.panNumber ?? null)
    .input('uanNumber', sql.VarChar(20), input.uanNumber ?? null)
    .input('esiNumber', sql.VarChar(25), input.esiNumber ?? null)
    .input(
      'appointmentLetterDate',
      sql.Date,
      input.appointmentLetterDate ? parseDateOnly(input.appointmentLetterDate) : null,
    )
    .input('createdBy', sql.Int, createdBy).query<{
      EmployeeId: number
      EmployeeCode: string
    }>(`
      DECLARE @sequenceValue INT = NEXT VALUE FOR dbo.EmployeeCodeSeq;
      DECLARE @employeeCode VARCHAR(20) =
          'EMP' + CASE WHEN @sequenceValue < 1000
                       THEN RIGHT('000' + CAST(@sequenceValue AS VARCHAR(10)), 3)
                       ELSE CAST(@sequenceValue AS VARCHAR(10))
                  END;

      INSERT INTO dbo.Employees (EmployeeCode, EmployeeName, JoiningDate,
                                 Department, Designation, PhoneNumber, DateOfBirth,
                                 PostAppliedFor, CategoryOfWorkmen, AadhaarNumber,
                                 PanNumber, UanNumber, EsiNumber, AppointmentLetterDate,
                                 CreatedBy)
      OUTPUT INSERTED.EmployeeId, INSERTED.EmployeeCode
      VALUES (@employeeCode, @employeeName, @joiningDate,
              @department, @designation, @phoneNumber, @dateOfBirth,
              @postAppliedFor, @categoryOfWorkmen, @aadhaarNumber,
              @panNumber, @uanNumber, @esiNumber, @appointmentLetterDate,
              @createdBy);`)

  const row = result.recordset[0]
  if (!row) throw new Error('Employee insert returned no row')
  return { employeeId: row.EmployeeId, employeeCode: row.EmployeeCode }
}

/**
 * Applies exactly the fields the caller sent.
 *
 * A PATCH that omits `department` must leave it alone, while one that sends
 * null must clear it - so presence is tested with `in`, which can tell those
 * two apart, rather than with a truthiness check, which cannot.
 */
export async function update(employeeId: number, input: UpdateEmployeeInput): Promise<boolean> {
  const request = await createRequest()
  const assignments: string[] = []

  if (input.employeeName !== undefined) {
    assignments.push('EmployeeName = @employeeName')
    request.input('employeeName', sql.NVarChar(150), input.employeeName)
  }
  if (input.joiningDate !== undefined) {
    assignments.push('JoiningDate = @joiningDate')
    request.input('joiningDate', sql.Date, parseDateOnly(input.joiningDate))
  }
  if ('department' in input) {
    assignments.push('Department = @department')
    request.input('department', sql.NVarChar(100), input.department ?? null)
  }
  if ('designation' in input) {
    assignments.push('Designation = @designation')
    request.input('designation', sql.NVarChar(100), input.designation ?? null)
  }
  if ('phoneNumber' in input) {
    assignments.push('PhoneNumber = @phoneNumber')
    request.input('phoneNumber', sql.VarChar(20), input.phoneNumber ?? null)
  }
  if ('dateOfBirth' in input) {
    assignments.push('DateOfBirth = @dateOfBirth')
    request.input('dateOfBirth', sql.Date, input.dateOfBirth ? parseDateOnly(input.dateOfBirth) : null)
  }
  if ('postAppliedFor' in input) {
    assignments.push('PostAppliedFor = @postAppliedFor')
    request.input('postAppliedFor', sql.NVarChar(100), input.postAppliedFor ?? null)
  }
  if ('categoryOfWorkmen' in input) {
    assignments.push('CategoryOfWorkmen = @categoryOfWorkmen')
    request.input('categoryOfWorkmen', sql.NVarChar(100), input.categoryOfWorkmen ?? null)
  }
  if ('aadhaarNumber' in input) {
    assignments.push('AadhaarNumber = @aadhaarNumber')
    request.input('aadhaarNumber', sql.VarChar(20), input.aadhaarNumber ?? null)
  }
  if ('panNumber' in input) {
    assignments.push('PanNumber = @panNumber')
    request.input('panNumber', sql.VarChar(10), input.panNumber ?? null)
  }
  if ('uanNumber' in input) {
    assignments.push('UanNumber = @uanNumber')
    request.input('uanNumber', sql.VarChar(20), input.uanNumber ?? null)
  }
  if ('esiNumber' in input) {
    assignments.push('EsiNumber = @esiNumber')
    request.input('esiNumber', sql.VarChar(25), input.esiNumber ?? null)
  }
  if ('appointmentLetterDate' in input) {
    assignments.push('AppointmentLetterDate = @appointmentLetterDate')
    request.input(
      'appointmentLetterDate',
      sql.Date,
      input.appointmentLetterDate ? parseDateOnly(input.appointmentLetterDate) : null,
    )
  }

  if (assignments.length === 0) return true

  // Literals again: each entry is a fixed 'Column = @parameter' string.
  const SET_CLAUSE = assignments.join(', ')

  const result = await request.input('employeeId', sql.Int, employeeId).query(`
      UPDATE dbo.Employees
      SET    ${SET_CLAUSE},
             UpdatedAt = SYSUTCDATETIME()
      WHERE  EmployeeId = @employeeId`)

  return (result.rowsAffected[0] ?? 0) > 0
}

/**
 * Archives or restores an employee.
 *
 * Employees are archived, never deleted (standing assumption 2): their
 * documents, their audit trail and their employee code all have to stay
 * meaningful after they leave. The `IsActive <> @isActive` predicate makes the
 * call idempotent and lets the caller see whether anything actually changed.
 */
export async function setActive(employeeId: number, isActive: boolean): Promise<boolean> {
  const request = await createRequest()
  const result = await request
    .input('employeeId', sql.Int, employeeId)
    .input('isActive', sql.Bit, isActive).query(`
      UPDATE dbo.Employees
      SET    IsActive = @isActive,
             UpdatedAt = SYSUTCDATETIME()
      WHERE  EmployeeId = @employeeId AND IsActive <> @isActive`)

  return (result.rowsAffected[0] ?? 0) > 0
}

/**
 * The departments and designations actually in use.
 *
 * Both are free text by business rule (Section 89, items 4 and 5), so there is
 * no lookup table to read: the filter options are whatever HR has entered so
 * far, which is also why they are read fresh rather than cached.
 */
export async function listFacets(): Promise<{ departments: string[]; designations: string[] }> {
  const request = await createRequest()
  const result = await request.query<{ Kind: string; Value: string }>(`
      SELECT DISTINCT 'department' AS Kind, e.Department AS Value
      FROM   dbo.Employees AS e
      WHERE  e.Department IS NOT NULL AND LEN(LTRIM(RTRIM(e.Department))) > 0
      UNION
      SELECT DISTINCT 'designation' AS Kind, e.Designation AS Value
      FROM   dbo.Employees AS e
      WHERE  e.Designation IS NOT NULL AND LEN(LTRIM(RTRIM(e.Designation))) > 0
      ORDER BY Kind, Value`)

  return {
    departments: result.recordset.filter((row) => row.Kind === 'department').map((row) => row.Value),
    designations: result.recordset
      .filter((row) => row.Kind === 'designation')
      .map((row) => row.Value),
  }
}
