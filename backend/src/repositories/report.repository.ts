import { createRequest, sql } from '../database/pool.js'
import { COUNTABLE_DOCUMENT } from './employeeScope.js'
import {
  todayDateOnly,
  parseDateOnly,
  formatDateOnly,
  type ExitReason,
} from '@asps-dms/shared'

/**
 * The reports.
 *
 * Two questions the office actually asks, answered separately because they are
 * read by different people for different reasons:
 *
 *   1. WHICH DOCUMENT is holding everyone up. A short table, one row per
 *      document type, that says where to put the effort.
 *   2. WHO is outstanding. A long table, one row per employee, that says who to
 *      chase - and which documents to ask them for.
 *
 * Both count ACTIVE employees and active checklist rows only. An archived
 * employee has left; their outstanding paperwork is a number nobody can ever
 * bring down, and leaving it in a report makes every total permanently wrong.
 */

const MAX_ROWS = 1000

export interface DocumentTypeReportRow {
  documentTypeId: number
  documentName: string
  isMandatory: boolean
  /** Employees this document is expected from. */
  expected: number
  received: number
  outstanding: number
  overdue: number
}

export async function byDocumentType(): Promise<DocumentTypeReportRow[]> {
  const request = await createRequest()
  const result = await request
    .input('today', sql.Date, parseDateOnly(todayDateOnly()))
    .query<{
      DocumentTypeId: number
      DocumentName: string
      IsMandatory: boolean
      Expected: number
      Received: number
      Overdue: number
    }>(`
      SELECT  dt.DocumentTypeId, dt.DocumentName, dt.IsMandatory,
              COUNT(*) AS Expected,
              SUM(CASE WHEN d.OriginalFilePath IS NOT NULL THEN 1 ELSE 0 END) AS Received,
              SUM(CASE WHEN d.OriginalFilePath IS NULL
                        AND d.DueDate IS NOT NULL AND d.DueDate < @today
                       THEN 1 ELSE 0 END) AS Overdue
      FROM    dbo.EmployeeDocuments AS d
      INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
      INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
      WHERE   ${COUNTABLE_DOCUMENT}
      GROUP BY dt.DocumentTypeId, dt.DocumentName, dt.IsMandatory, dt.SortOrder
      ORDER BY dt.SortOrder
    `)

  return result.recordset.map((row) => ({
    documentTypeId: row.DocumentTypeId,
    documentName: row.DocumentName,
    isMandatory: row.IsMandatory,
    expected: row.Expected,
    received: row.Received,
    outstanding: row.Expected - row.Received,
    overdue: row.Overdue,
  }))
}

export interface OutstandingReportRow {
  employeeId: number
  employeeCode: string
  employeeName: string
  department: string | null
  designation: string | null
  joiningDate: string
  outstanding: number
  overdue: number
  /** The documents still to come, named, so the row is actionable on its own. */
  documents: string
}

export interface OutstandingReportQuery {
  department?: string | undefined
  onlyOverdue?: boolean | undefined
  onlyMandatory?: boolean | undefined
}

/**
 * Every employee with something outstanding, and what it is.
 *
 * The document names are gathered in SQL with FOR XML PATH rather than by
 * running a second query per employee: 568 employees would otherwise be 569
 * round trips. STUFF/FOR XML because this is SQL Server 2014 - STRING_AGG
 * arrived in 2017 and would fail on the company's server.
 */
export async function outstanding(
  query: OutstandingReportQuery,
): Promise<{ rows: OutstandingReportRow[]; truncated: boolean }> {
  const request = await createRequest()
  request.input('today', sql.Date, parseDateOnly(todayDateOnly()))
  request.input('maxRows', sql.Int, MAX_ROWS + 1)

  const conditions = [
    // Compliance is about the people who are here. A leaver's missing form is
    // not a gap anybody can close, and counting it drags the percentage down
    // for ever.
    COUNTABLE_DOCUMENT,
    'd.OriginalFilePath IS NULL',
  ]

  if (query.department) {
    conditions.push('e.Department = @department')
    request.input('department', sql.NVarChar(100), query.department)
  }
  if (query.onlyOverdue) {
    conditions.push('d.DueDate IS NOT NULL AND d.DueDate < @today')
  }
  if (query.onlyMandatory) {
    conditions.push('dt.IsMandatory = 1')
  }

  // Literals only: every condition is a fixed string naming a bound parameter.
  const WHERE = conditions.join(' AND ')

  const result = await request.query<{
    EmployeeId: number
    EmployeeCode: string
    EmployeeName: string
    Department: string | null
    Designation: string | null
    JoiningDate: Date
    Outstanding: number
    Overdue: number
    Documents: string | null
  }>(`
    SELECT TOP (@maxRows)
           e.EmployeeId, e.EmployeeCode, e.EmployeeName, e.Department, e.Designation,
           e.JoiningDate,
           COUNT(*) AS Outstanding,
           SUM(CASE WHEN d.DueDate IS NOT NULL AND d.DueDate < @today THEN 1 ELSE 0 END) AS Overdue,
           STUFF((
               SELECT ', ' + dt2.DocumentName
               FROM   dbo.EmployeeDocuments AS d2
               INNER JOIN dbo.DocumentTypes AS dt2 ON dt2.DocumentTypeId = d2.DocumentTypeId
               WHERE  d2.EmployeeId = e.EmployeeId
                 AND  d2.IsActive = 1
                 AND  d2.OriginalFilePath IS NULL
               ORDER BY dt2.SortOrder
               FOR XML PATH(''), TYPE
           ).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS Documents
    FROM   dbo.EmployeeDocuments AS d
    INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
    INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
    WHERE  ${WHERE}
    GROUP BY e.EmployeeId, e.EmployeeCode, e.EmployeeName, e.Department, e.Designation,
             e.JoiningDate
    ORDER BY Overdue DESC, Outstanding DESC, e.EmployeeCode
  `)

  const truncated = result.recordset.length > MAX_ROWS
  const rows = (truncated ? result.recordset.slice(0, MAX_ROWS) : result.recordset).map((row) => ({
    employeeId: row.EmployeeId,
    employeeCode: row.EmployeeCode,
    employeeName: row.EmployeeName,
    department: row.Department,
    designation: row.Designation,
    joiningDate: formatDateOnly(row.JoiningDate),
    outstanding: row.Outstanding,
    overdue: row.Overdue,
    documents: row.Documents ?? '',
  }))

  return { rows, truncated }
}

/**
 * Who left, when, why, and how long they were here.
 *
 * Reads the employee rows rather than deriving anything from documents: an exit
 * is a fact about a person, and the one report that must keep working long
 * after their checklist has stopped mattering.
 *
 * Ordered by the last working day, most recent first, because the question this
 * answers is almost always 'who has gone recently'.
 */
export interface ExitReportRow {
  employeeId: number
  employeeCode: string
  employeeName: string
  department: string | null
  designation: string | null
  joiningDate: string
  resignationDate: string
  lastWorkingDate: string
  exitReason: ExitReason
  /** Counting the first day and the last, so a single-day stint is 1. */
  daysWorked: number
  /**
   * False while they are working their notice.
   *
   * The report used to list only people whose last day had already passed, so
   * recording an exit and then opening the report showed nothing - which reads
   * as the exit not having saved. Everyone with an exit recorded is listed, and
   * this says which of the two they are.
   */
  hasGone: boolean
}

export async function exits(): Promise<ExitReportRow[]> {
  const request = await createRequest()
  const result = await request.query<{
    EmployeeId: number
    EmployeeCode: string
    EmployeeName: string
    Department: string | null
    Designation: string | null
    JoiningDate: Date
    ResignationDate: Date
    LastWorkingDate: Date
    ExitReason: ExitReason
    DaysWorked: number
    HasGone: number
  }>(`
      SELECT  e.EmployeeId, e.EmployeeCode, e.EmployeeName,
              e.Department, e.Designation,
              e.JoiningDate, e.ResignationDate, e.LastWorkingDate, e.ExitReason,
              DATEDIFF(DAY, e.JoiningDate, e.LastWorkingDate) + 1 AS DaysWorked,
              CASE WHEN e.LastWorkingDate < CAST(SYSUTCDATETIME() AS date) THEN 1 ELSE 0 END AS HasGone
      FROM    dbo.Employees AS e
      WHERE   e.ResignationDate IS NOT NULL
        AND   e.LastWorkingDate IS NOT NULL
      ORDER BY e.LastWorkingDate DESC, e.EmployeeName
    `)

  return result.recordset.map((row) => ({
    employeeId: row.EmployeeId,
    employeeCode: row.EmployeeCode,
    employeeName: row.EmployeeName,
    department: row.Department,
    designation: row.Designation,
    joiningDate: formatDateOnly(row.JoiningDate),
    resignationDate: formatDateOnly(row.ResignationDate),
    lastWorkingDate: formatDateOnly(row.LastWorkingDate),
    exitReason: row.ExitReason,
    daysWorked: row.DaysWorked,
    // CASE returns 0/1, not a bit, so it arrives as a number.
    hasGone: row.HasGone === 1,
  }))
}

/** Exits per department, so the report can show where people are leaving from. */
export interface ExitsByDepartmentRow {
  department: string | null
  exits: number
}

export async function exitsByDepartment(): Promise<ExitsByDepartmentRow[]> {
  const request = await createRequest()
  const result = await request.query<{ Department: string | null; Exits: number }>(`
      SELECT  e.Department, COUNT(*) AS Exits
      FROM    dbo.Employees AS e
      WHERE   e.ResignationDate IS NOT NULL
      GROUP BY e.Department
      ORDER BY COUNT(*) DESC, e.Department
    `)

  return result.recordset.map((row) => ({ department: row.Department, exits: row.Exits }))
}

/**
 * The employees behind one row of the by-document report.
 *
 * The count on that row and the number of rows here MUST agree, so the
 * predicates are the same ones: an active employee, an active checklist row,
 * and - by default - nothing attached yet. A drill-down that disagrees with the
 * figure it was opened from is worse than no drill-down, because it makes both
 * numbers untrustworthy.
 *
 * Paged in SQL rather than in the browser. There are 568 employees and ten
 * document types; sending every row so the screen can show twenty-five of them
 * is a habit that works until the day it does not.
 */
export interface DocumentEmployeeRow {
  employeeId: number
  employeeCode: string
  employeeName: string
  department: string | null
  designation: string | null
  /** 'Received' once a file is attached; otherwise Pending or Overdue. */
  state: 'Received' | 'Overdue' | 'Pending'
  dueDate: string | null
  /** Positive when overdue, negative when still due, null with no deadline. */
  daysOverdue: number | null
}

export const DOCUMENT_EMPLOYEE_SORT_KEYS = [
  'employeeName',
  'employeeCode',
  'department',
  'designation',
  'dueDate',
  'daysOverdue',
] as const

export type DocumentEmployeeSortKey = (typeof DOCUMENT_EMPLOYEE_SORT_KEYS)[number]

/** Sort keys to columns. The enum in the schema is the only way in. */
const DOCUMENT_EMPLOYEE_SORT_COLUMNS: Readonly<Record<DocumentEmployeeSortKey, string>> = {
  employeeName: 'e.EmployeeName',
  employeeCode: 'e.EmployeeCode',
  department: 'e.Department',
  designation: 'e.Designation',
  dueDate: 'd.DueDate',
  // The oldest overdue first is the default, and it is the same column read the
  // other way: a due date further in the past is more days overdue.
  daysOverdue: 'd.DueDate',
}

/** What decides WHICH employees this list holds, and in what order. */
export interface DocumentEmployeeFilter {
  documentTypeId: number
  /** False shows employees who have already sent it in as well. */
  outstandingOnly: boolean
  onlyOverdue: boolean
  department?: string
  sortBy: DocumentEmployeeSortKey
  sortDir: 'asc' | 'desc'
}

export interface DocumentEmployeeQuery extends DocumentEmployeeFilter {
  page: number
  pageSize: number
}

/**
 * The predicates and the ordering, built once for both readers of this list.
 *
 * The screen pages through it and the printed list takes the whole of it, and
 * they MUST select the same people in the same order - a PDF that quietly holds
 * a different set from the table it was printed from is worse than no PDF. So
 * the two share this, and the only difference between them is the paging.
 */
function documentEmployeeShape(
  request: sql.Request,
  filter: DocumentEmployeeFilter,
): { where: string; orderBy: string } {
  const conditions = [
    // Only the people who are still here. Somebody who has left cannot bring a
    // document in, and listing them gives HR a name they cannot act on.
    COUNTABLE_DOCUMENT,
    'd.DocumentTypeId = @documentTypeId',
  ]

  if (filter.outstandingOnly) conditions.push('d.OriginalFilePath IS NULL')
  if (filter.onlyOverdue) {
    conditions.push('d.OriginalFilePath IS NULL AND d.DueDate IS NOT NULL AND d.DueDate < @today')
  }
  if (filter.department) {
    conditions.push('e.Department = @department')
    request.input('department', sql.NVarChar(100), filter.department)
  }

  const direction = filter.sortDir === 'desc' ? 'DESC' : 'ASC'
  // Literals only: the column comes from a fixed table keyed by an enum, and
  // the direction is one of two words. EmployeeId breaks ties so paging is
  // stable - without it two rows that sort equally can appear on two pages, or
  // on neither.
  return {
    where: conditions.join(' AND '),
    orderBy: `${DOCUMENT_EMPLOYEE_SORT_COLUMNS[filter.sortBy]} ${direction}, e.EmployeeId ASC`,
  }
}

interface DocumentEmployeeRecord {
  EmployeeId: number
  EmployeeCode: string
  EmployeeName: string
  Department: string | null
  Designation: string | null
  HasFile: number
  DueDate: Date | null
  DaysOverdue: number | null
}

/** The columns both queries select. Written once so the two cannot drift apart. */
const DOCUMENT_EMPLOYEE_COLUMNS = `
            e.EmployeeId, e.EmployeeCode, e.EmployeeName, e.Department, e.Designation,
            CASE WHEN d.OriginalFilePath IS NULL THEN 0 ELSE 1 END AS HasFile,
            d.DueDate,
            CASE WHEN d.DueDate IS NULL OR d.OriginalFilePath IS NOT NULL THEN NULL
                 ELSE DATEDIFF(DAY, d.DueDate, @today) END AS DaysOverdue`

function toDocumentEmployeeRow(row: DocumentEmployeeRecord): DocumentEmployeeRow {
  return {
    employeeId: row.EmployeeId,
    employeeCode: row.EmployeeCode,
    employeeName: row.EmployeeName,
    department: row.Department,
    designation: row.Designation,
    state:
      row.HasFile === 1
        ? ('Received' as const)
        : row.DaysOverdue !== null && row.DaysOverdue > 0
          ? ('Overdue' as const)
          : ('Pending' as const),
    dueDate: row.DueDate === null ? null : formatDateOnly(row.DueDate),
    daysOverdue: row.DaysOverdue,
  }
}

export async function employeesForDocumentType(
  query: DocumentEmployeeQuery,
): Promise<{ rows: DocumentEmployeeRow[]; total: number }> {
  const request = await createRequest()
  const today = todayDateOnly()
  request
    .input('today', sql.Date, parseDateOnly(today))
    .input('documentTypeId', sql.Int, query.documentTypeId)
    .input('offset', sql.Int, (query.page - 1) * query.pageSize)
    .input('pageSize', sql.Int, query.pageSize)

  const { where: WHERE, orderBy: ORDER_BY } = documentEmployeeShape(request, query)

  const result = await request.query<DocumentEmployeeRecord & { Total: number }>(`
    SELECT  ${DOCUMENT_EMPLOYEE_COLUMNS},
            COUNT(*) OVER () AS Total
    FROM    dbo.EmployeeDocuments AS d
    INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
    WHERE   ${WHERE}
    ORDER BY ${ORDER_BY}
    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
  `)

  return {
    rows: result.recordset.map(toDocumentEmployeeRow),
    total: result.recordset[0]?.Total ?? 0,
  }
}

/**
 * EVERY employee the same filters match, unpaged, for the printed list.
 *
 * Printing the page the screen happens to be showing is the mistake this exists
 * to prevent: HR looking at 25 of 41 and handing a department head a sheet that
 * silently leaves 16 people off it.
 *
 * Unbounded on purpose, and safely so - dbo.EmployeeDocuments holds one row per
 * employee per document type, so filtering to ONE type caps this at the number
 * of employees however the filters are set.
 */
export async function allEmployeesForDocumentType(
  filter: DocumentEmployeeFilter,
): Promise<DocumentEmployeeRow[]> {
  const request = await createRequest()
  const today = todayDateOnly()
  request
    .input('today', sql.Date, parseDateOnly(today))
    .input('documentTypeId', sql.Int, filter.documentTypeId)

  const { where: WHERE, orderBy: ORDER_BY } = documentEmployeeShape(request, filter)

  const result = await request.query<DocumentEmployeeRecord>(`
    SELECT  ${DOCUMENT_EMPLOYEE_COLUMNS}
    FROM    dbo.EmployeeDocuments AS d
    INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
    WHERE   ${WHERE}
    ORDER BY ${ORDER_BY}
  `)

  return result.recordset.map(toDocumentEmployeeRow)
}
