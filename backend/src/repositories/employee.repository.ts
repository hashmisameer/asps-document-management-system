import {
  DOCUMENT_STATUS,
  EMPLOYEE_STATUS_FILTERS,
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
  type EmploymentStatus,
  type ExitReason,
  type JoinedWithinPeriod,
  type MarkEmployeeLeftInput,
  type Paginated,
  type UpdateEmployeeInput,
} from '@asps-dms/shared'
import { createRequest, sql } from '../database/pool.js'
import { escapeLike } from '../utils/sqlLike.js'
import { EFFECTIVE_LEFT, IDENTITY_CARD_CODES_SQL } from './employeeScope.js'

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
  Address: string | null
  Email: string | null
  DateOfBirth: Date | null
  Gender: string | null
  PostAppliedFor: string | null
  CategoryOfWorkmen: string | null
  AadhaarNumber: string | null
  PanNumber: string | null
  UanNumber: string | null
  EsiNumber: string | null
  AppointmentLetterDate: Date | null
  PhotoMimeType: string | null
  PhotoUploadedAt: Date | null
  EmploymentStatus: EmploymentStatus
  ResignationDate: Date | null
  LastWorkingDate: Date | null
  ExitReason: ExitReason | null
  ExitNotes: string | null
  IsActive: boolean
  CreatedAt: Date
  UpdatedAt: Date
}

interface EmployeeProfileRow extends EmployeeRow {
  SignatureUpdatedAt: Date | null
}

const SELECT_EMPLOYEE_COLUMNS = `
             e.EmployeeId, e.EmployeeCode, e.EmployeeName, e.JoiningDate,
             e.Department, e.Designation, e.PhoneNumber, e.Address, e.Email, e.DateOfBirth,
             e.Gender, e.PostAppliedFor, e.CategoryOfWorkmen, e.AadhaarNumber, e.PanNumber,
             e.UanNumber, e.EsiNumber, e.AppointmentLetterDate,
             e.PhotoMimeType, e.PhotoUploadedAt,
             e.EmploymentStatus, e.ResignationDate, e.LastWorkingDate,
             e.ExitReason, e.ExitNotes,
             e.IsActive, e.CreatedAt, e.UpdatedAt`

/**
 * The same columns without the identity numbers, for the list.
 *
 * A list is the one screen that would put Aadhaar and PAN numbers on screen in
 * bulk, and nothing on it has any use for them.
 */
const SELECT_EMPLOYEE_LIST_COLUMNS = `
             e.EmployeeId, e.EmployeeCode, e.EmployeeName, e.JoiningDate,
             e.Department, e.Designation, e.PhoneNumber, e.Address, e.Email, e.DateOfBirth,
             e.Gender, e.PostAppliedFor, e.CategoryOfWorkmen,
             CAST(NULL AS VARCHAR(20)) AS AadhaarNumber,
             CAST(NULL AS VARCHAR(10)) AS PanNumber,
             CAST(NULL AS VARCHAR(20)) AS UanNumber,
             CAST(NULL AS VARCHAR(25)) AS EsiNumber,
             e.AppointmentLetterDate,
             e.PhotoMimeType, e.PhotoUploadedAt,
             e.EmploymentStatus, e.ResignationDate, e.LastWorkingDate,
             e.ExitReason, e.ExitNotes,
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
    address: row.Address,
    email: row.Email,
    dateOfBirth: row.DateOfBirth === null ? null : formatDateOnly(row.DateOfBirth),
    gender: (row.Gender as Employee['gender']) ?? null,
    postAppliedFor: row.PostAppliedFor,
    categoryOfWorkmen: row.CategoryOfWorkmen,
    aadhaarNumber: row.AadhaarNumber,
    panNumber: row.PanNumber,
    uanNumber: row.UanNumber,
    esiNumber: row.EsiNumber,
    appointmentLetterDate:
      row.AppointmentLetterDate === null ? null : formatDateOnly(row.AppointmentLetterDate),
    hasPhoto: row.PhotoUploadedAt !== null,
    photoUpdatedAt: row.PhotoUploadedAt?.toISOString() ?? null,
    employmentStatus: row.EmploymentStatus,
    resignationDate: row.ResignationDate === null ? null : formatDateOnly(row.ResignationDate),
    lastWorkingDate: row.LastWorkingDate === null ? null : formatDateOnly(row.LastWorkingDate),
    exitReason: row.ExitReason,
    exitNotes: row.ExitNotes,
    isActive: row.IsActive,
    createdAt: row.CreatedAt.toISOString(),
    updatedAt: row.UpdatedAt.toISOString(),
  }
}

/**
 * Joining-date periods -> the SQL that expresses them.
 *
 * Written as DATEADD against the bound @today rather than GETDATE(), so the
 * boundary is the same one the rest of the request uses and a query that runs
 * across midnight cannot answer two different questions.
 */
const JOINED_WITHIN_SQL: Readonly<Record<JoinedWithinPeriod, string>> = {
  week: 'DATEADD(DAY, -7, @today)',
  month: 'DATEADD(MONTH, -1, @today)',
  sixMonths: 'DATEADD(MONTH, -6, @today)',
  year: 'DATEADD(YEAR, -1, @today)',
}

/** sortBy keys -> columns. The enum in the shared schema is the only way in. */
const SORT_COLUMNS: Readonly<Record<EmployeeSortKey, string>> = {
  /* Counted in the OUTER APPLY above rather than stored: descending puts the
     employee with the most outstanding documents first, which is the order
     somebody working through the Incomplete list reads it in. */
  documentsPending: '(c.Total - c.Completed)',
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

  // 'Only the archived' is a different question from 'archived as well', and
  // the dashboard's Archived tile asks the first one.
  if (query.archivedOnly) conditions.push('e.IsActive = 0')
  else if (!query.includeArchived) conditions.push('e.IsActive = 1')

  // Still here, on the way out, or both. Filtering only; no row is ever removed.
  //
  // LEFT here means AN EXIT HAS BEEN RECORDED, not that the last day has already
  // passed. Somebody marked as leaving on the 30th is still working until then,
  // and the first thing whoever recorded it does is look for them under 'Left' -
  // finding an empty list reads as the exit not having saved. They appear under
  // 'Active' too, deliberately: they are still employed, still owe documents and
  // must not drop off the list that is used to chase them.
  if (query.status === EMPLOYEE_STATUS_FILTERS.ACTIVE) {
    conditions.push(`NOT ${EFFECTIVE_LEFT}`)
  } else if (query.status === EMPLOYEE_STATUS_FILTERS.LEFT) {
    conditions.push('e.ResignationDate IS NOT NULL')
  }

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
  if (query.joinedWithin) {
    // The period is an enum, and this is a lookup into a table of fixed SQL -
    // nothing the caller sent reaches the query text.
    conditions.push(`e.JoiningDate >= ${JOINED_WITHIN_SQL[query.joinedWithin]}`)
  }

  /*
   * The dashboard's filters.
   *
   * Every predicate below is written to match the one the tile counted with,
   * because a tile saying 5 that opens a list of 4 is read as the list being
   * wrong - and one of them IS wrong. dashboard.repository.ts holds the other
   * copy of each; they are asserted against each other in the tests.
   */

  if (query.gender) {
    // Not a fourth gender: 'notRecorded' is the absence of one, which is a real
    // answer and is why the dashboard shows it rather than folding it in.
    if (query.gender === 'notRecorded') {
      conditions.push('e.Gender IS NULL')
    } else {
      conditions.push('e.Gender = @gender')
      request.input('gender', sql.VarChar(10), query.gender)
    }
  }

  if (query.leftThisYear) {
    conditions.push(
      'e.LastWorkingDate IS NOT NULL AND e.LastWorkingDate < @today' +
        ' AND YEAR(e.LastWorkingDate) = YEAR(@today)',
    )
  }

  /*
   * An employee whose Aadhaar or PAN has never come in.
   *
   * By CODE rather than by the mandatory flag. It was the flag, which picked out
   * the two cards only for as long as they were the only mandatory documents -
   * eight of the ten are mandatory now, and this quietly became 'missing
   * anything at all'.
   */
  if (query.missingIdCard) {
    conditions.push(`EXISTS (
      SELECT 1
      FROM   dbo.EmployeeDocuments AS idc
      INNER JOIN dbo.DocumentTypes AS idt ON idt.DocumentTypeId = idc.DocumentTypeId
      WHERE  idc.EmployeeId = e.EmployeeId
        AND  idc.IsActive = 1
        AND  idt.DocumentCode IN (${IDENTITY_CARD_CODES_SQL})
        AND  idc.OriginalFilePath IS NULL
    )`)
  }

  if (query.withoutSignature) {
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM dbo.EmployeeSignatures AS sig
      WHERE  sig.EmployeeId = e.EmployeeId AND sig.IsActive = 1
    )`)
  }

  /*
   * Whether their checklist is finished.
   *
   * OUTSTANDING is the same expression the counters above use - a row whose
   * status is not one of the three that mean a file arrived and was not
   * rejected - and the same one the dashboard counts these cards with. A
   * REJECTED document is outstanding: the file was refused, so the paper is
   * still to be collected.
   *
   * EXISTS and NOT EXISTS over one condition, so 'complete' and 'incomplete'
   * between them return every employee the other filters allow and never the
   * same one twice.
   */
  if (query.checklist) {
    const OUTSTANDING = `SELECT 1
      FROM   dbo.EmployeeDocuments AS cd
      WHERE  cd.EmployeeId = e.EmployeeId
        AND  cd.IsActive = 1
        AND  cd.Status NOT IN (@stUploaded, @stUnderReview, @stVerified)`

    conditions.push(
      query.checklist === 'incomplete' ? `EXISTS (${OUTSTANDING})` : `NOT EXISTS (${OUTSTANDING})`,
    )
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
 * EmployeeCode is supplied by the caller when the company already numbers its
 * staff, and generated when it does not: dbo.EmployeeCodeSeq, formatted
 * EMP001..EMP999 and then EMP1000 onwards so it keeps working past 999 without
 * renumbering. The sequence is drawn from ONLY when no code was given, so
 * typing one does not silently burn a number.
 *
 * The UNIQUE constraint on the column is the final guarantee either way, and is
 * what catches a hand-typed code colliding with one already in use - or with
 * one the sequence reaches later.
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
    .input('address', sql.NVarChar(500), input.address ?? null)
    .input('email', sql.NVarChar(200), input.email ?? null)
    .input('dateOfBirth', sql.Date, input.dateOfBirth ? parseDateOnly(input.dateOfBirth) : null)
    .input('gender', sql.VarChar(10), input.gender ?? null)
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
    .input('suppliedCode', sql.VarChar(20), input.employeeCode ?? null)
    .input('createdBy', sql.Int, createdBy).query<{
      EmployeeId: number
      EmployeeCode: string
    }>(`
      DECLARE @employeeCode VARCHAR(20) = @suppliedCode;

      IF @employeeCode IS NULL
      BEGIN
          DECLARE @sequenceValue INT = NEXT VALUE FOR dbo.EmployeeCodeSeq;
          SET @employeeCode =
              'EMP' + CASE WHEN @sequenceValue < 1000
                           THEN RIGHT('000' + CAST(@sequenceValue AS VARCHAR(10)), 3)
                           ELSE CAST(@sequenceValue AS VARCHAR(10))
                      END;
      END

      INSERT INTO dbo.Employees (EmployeeCode, EmployeeName, JoiningDate,
                                 Department, Designation, PhoneNumber, Address, Email, DateOfBirth,
                                 Gender, PostAppliedFor, CategoryOfWorkmen, AadhaarNumber,
                                 PanNumber, UanNumber, EsiNumber, AppointmentLetterDate,
                                 CreatedBy)
      OUTPUT INSERTED.EmployeeId, INSERTED.EmployeeCode
      VALUES (@employeeCode, @employeeName, @joiningDate,
              @department, @designation, @phoneNumber, @address, @email, @dateOfBirth,
              @gender, @postAppliedFor, @categoryOfWorkmen, @aadhaarNumber,
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
  if ('gender' in input) {
    assignments.push('Gender = @gender')
    request.input('gender', sql.VarChar(10), input.gender ?? null)
  }
  if ('phoneNumber' in input) {
    assignments.push('PhoneNumber = @phoneNumber')
    request.input('phoneNumber', sql.VarChar(20), input.phoneNumber ?? null)
  }
  if ('address' in input) {
    assignments.push('Address = @address')
    request.input('address', sql.NVarChar(500), input.address ?? null)
  }
  if ('email' in input) {
    assignments.push('Email = @email')
    request.input('email', sql.NVarChar(200), input.email ?? null)
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
 * Records that an employee has left.
 *
 * The STATUS is derived, not passed in: somebody who resigns today with a last
 * working day at the end of the month is still working here, and saying
 * otherwise would stop their checklist a month early and take them off the
 * active headcount while they are still turning up. It flips on its own once
 * that date has passed, because `list` and the dashboard read the column and
 * `refreshEmploymentStatus` moves it.
 *
 * Nothing is deleted and nothing is archived. The employee stays exactly where
 * they were, with a leaving date on them.
 */
export async function markLeft(
  employeeId: number,
  input: MarkEmployeeLeftInput,
  today: string,
): Promise<boolean> {
  const request = await createRequest()
  const result = await request
    .input('employeeId', sql.Int, employeeId)
    .input('resignationDate', sql.Date, parseDateOnly(input.resignationDate))
    .input('lastWorkingDate', sql.Date, parseDateOnly(input.lastWorkingDate))
    .input('exitReason', sql.VarChar(20), input.exitReason)
    .input('exitNotes', sql.NVarChar(1000), input.exitNotes ?? null)
    .input('today', sql.Date, parseDateOnly(today)).query(`
      UPDATE dbo.Employees
      SET    ResignationDate  = @resignationDate,
             LastWorkingDate  = @lastWorkingDate,
             ExitReason       = @exitReason,
             ExitNotes        = @exitNotes,
             EmploymentStatus = CASE WHEN @lastWorkingDate < @today THEN 'LEFT' ELSE 'ACTIVE' END,
             UpdatedAt        = SYSUTCDATETIME()
      WHERE  EmployeeId = @employeeId`)

  return (result.rowsAffected[0] ?? 0) > 0
}

/**
 * Undoes an exit, putting the employee back exactly as they were.
 *
 * Clears the dates as well as the status, so an employee marked as having left
 * by mistake is not left carrying a resignation date nobody can see the effect
 * of. What happened is not erased - the audit trail keeps the exit, this undo,
 * and who did each.
 */
export async function undoExit(employeeId: number): Promise<boolean> {
  const request = await createRequest()
  const result = await request.input('employeeId', sql.Int, employeeId).query(`
      UPDATE dbo.Employees
      SET    EmploymentStatus = 'ACTIVE',
             ResignationDate  = NULL,
             LastWorkingDate  = NULL,
             ExitReason       = NULL,
             ExitNotes        = NULL,
             UpdatedAt        = SYSUTCDATETIME()
      WHERE  EmployeeId = @employeeId
        AND (EmploymentStatus = 'LEFT' OR ResignationDate IS NOT NULL)`)

  return (result.rowsAffected[0] ?? 0) > 0
}

/**
 * Turns ACTIVE into LEFT for anyone whose last working day has now passed.
 *
 * An exit is recorded in advance and takes effect on a date, so something has to
 * notice the date arriving. This is that, and it is written to be safe to run at
 * any time and as often as anyone likes.
 */
export async function refreshEmploymentStatus(today: string): Promise<number> {
  const request = await createRequest()
  const result = await request.input('today', sql.Date, parseDateOnly(today)).query(`
      UPDATE dbo.Employees
      SET    EmploymentStatus = 'LEFT',
             UpdatedAt = SYSUTCDATETIME()
      WHERE  EmploymentStatus = 'ACTIVE'
        AND  LastWorkingDate IS NOT NULL
        AND  LastWorkingDate < @today`)

  return result.rowsAffected[0] ?? 0
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

export interface StoredPhoto {
  filePath: string
  mimeType: string
  sizeBytes: number
}

/**
 * Replaces the employee's photograph.
 *
 * The previous file is left on disk, like a replaced document: only the current
 * one is ever served, and the earlier copy is there if a replacement turns out
 * to have been the wrong picture.
 */
export async function setPhoto(employeeId: number, photo: StoredPhoto): Promise<void> {
  const request = await createRequest()
  await request
    .input('employeeId', sql.Int, employeeId)
    .input('filePath', sql.NVarChar(500), photo.filePath)
    .input('mimeType', sql.VarChar(100), photo.mimeType)
    .input('sizeBytes', sql.BigInt, photo.sizeBytes).query(`
      UPDATE dbo.Employees
         SET PhotoFilePath      = @filePath,
             PhotoMimeType      = @mimeType,
             PhotoFileSizeBytes = @sizeBytes,
             PhotoUploadedAt    = SYSUTCDATETIME(),
             UpdatedAt          = SYSUTCDATETIME()
       WHERE EmployeeId = @employeeId`)
}

/** Where the photograph is, for the route that streams it. Null when there is none. */
export async function findPhoto(
  employeeId: number,
): Promise<{ filePath: string; mimeType: string } | null> {
  const request = await createRequest()
  const result = await request
    .input('employeeId', sql.Int, employeeId)
    .query<{ PhotoFilePath: string | null; PhotoMimeType: string | null }>(
      'SELECT PhotoFilePath, PhotoMimeType FROM dbo.Employees WHERE EmployeeId = @employeeId',
    )
  const row = result.recordset[0]
  if (!row?.PhotoFilePath) return null
  return { filePath: row.PhotoFilePath, mimeType: row.PhotoMimeType ?? 'application/octet-stream' }
}

/**
 * Every employee code in use, however the employee stands.
 *
 * Archived and left included, and deliberately: the code is unique across the
 * whole table, so an import that skipped an archived record would fail on the
 * insert instead of reporting a duplicate. 568 short strings is a cheap read
 * and it is only made by the import.
 */
export async function allEmployeeCodes(): Promise<Set<string>> {
  const request = await createRequest()
  const result = await request.query<{ EmployeeCode: string }>(
    'SELECT EmployeeCode FROM dbo.Employees',
  )
  return new Set(result.recordset.map((row) => row.EmployeeCode.toUpperCase()))
}