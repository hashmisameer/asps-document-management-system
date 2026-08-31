import { getPool } from '../database/pool.js'

/**
 * The documents a reminder is about: those with no file uploaded.
 *
 * "Pending" is deliberately about the FILE, not the status. A document that was
 * rejected still has no acceptable file against it and must keep being chased,
 * and a reminder that stopped at 'Rejected' would quietly drop exactly the
 * documents most in need of chasing. The reminder ends when a file arrives,
 * which is the thing the person receiving it is being asked to make happen.
 *
 * Archived employees are left out: nobody is chasing paperwork for someone who
 * has left, and their rows would grow the digest for ever.
 */

export interface PendingDocumentRow {
  employeeId: number
  employeeCode: string
  employeeName: string
  documentName: string
  isMandatory: boolean
  dueDate: string | null
}

interface Row {
  EmployeeId: number
  EmployeeCode: string
  EmployeeName: string
  DocumentName: string
  IsMandatory: boolean
  DueDate: Date | null
}

export async function findPendingDocuments(): Promise<PendingDocumentRow[]> {
  const pool = await getPool()
  const result = await pool.request().query<Row>(`
    SELECT  e.EmployeeId, e.EmployeeCode, e.EmployeeName,
            dt.DocumentName, dt.IsMandatory, d.DueDate
    FROM    dbo.EmployeeDocuments AS d
    INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
    INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
    WHERE   d.OriginalFilePath IS NULL
      AND   d.IsActive = 1
      AND   e.IsActive = 1
      AND   dt.IsActive = 1
    ORDER BY e.EmployeeCode, dt.SortOrder
  `)

  return result.recordset.map((row) => ({
    employeeId: row.EmployeeId,
    employeeCode: row.EmployeeCode,
    employeeName: row.EmployeeName,
    documentName: row.DocumentName,
    isMandatory: row.IsMandatory,
    // Date only. A due date is a calendar day, not an instant, and rendering it
    // through a timezone is how a deadline moves by one day.
    dueDate: row.DueDate ? row.DueDate.toISOString().slice(0, 10) : null,
  }))
}
