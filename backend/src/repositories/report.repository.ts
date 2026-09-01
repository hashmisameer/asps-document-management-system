import { createRequest, sql } from '../database/pool.js'
import { todayDateOnly, parseDateOnly, formatDateOnly } from '@asps-dms/shared'

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
      WHERE   d.IsActive = 1 AND e.IsActive = 1
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

  const conditions = ['d.IsActive = 1', 'e.IsActive = 1', 'd.OriginalFilePath IS NULL']

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
