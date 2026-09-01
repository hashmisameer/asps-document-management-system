import { createRequest, sql } from '../database/pool.js'
import { todayDateOnly } from '@asps-dms/shared'

/**
 * The numbers on the dashboard.
 *
 * One round trip for the whole page. Six separate endpoints would each read the
 * table at a slightly different moment, and a dashboard whose tiles disagree
 * with each other is worse than a slow one.
 *
 * Everything is counted against ACTIVE employees. An archived employee has left;
 * counting their outstanding paperwork would put a number on the screen that
 * nobody can ever bring down.
 */

export interface DashboardSummary {
  employees: {
    total: number
    male: number
    female: number
    other: number
    /** Employees whose gender was never recorded, reported rather than hidden. */
    notRecorded: number
    archived: number
    joinedLast30Days: number
  }
  documents: {
    total: number
    received: number
    verified: number
    pending: number
    overdue: number
    dueSoon: number
  }
  /** Active employees still missing at least one MANDATORY document. */
  employeesMissingMandatory: number
  signatures: {
    /** Documents that need a signature and have not been signed. */
    awaiting: number
    employeesWithoutSignature: number
  }
}

interface Row {
  Total: number
  Male: number
  Female: number
  Other: number
  NotRecorded: number
  Archived: number
  JoinedLast30Days: number
  DocTotal: number
  DocReceived: number
  DocVerified: number
  DocPending: number
  DocOverdue: number
  DocDueSoon: number
  MissingMandatory: number
  SignatureAwaiting: number
  WithoutSignature: number
}

export async function getSummary(dueSoonDays: number): Promise<DashboardSummary> {
  const request = await createRequest()
  const result = await request
    .input('today', sql.Date, new Date(`${todayDateOnly()}T00:00:00.000Z`))
    .input('dueSoonDays', sql.Int, dueSoonDays).query<Row>(`
      SELECT
        (SELECT COUNT(*) FROM dbo.Employees WHERE IsActive = 1) AS Total,
        (SELECT COUNT(*) FROM dbo.Employees WHERE IsActive = 1 AND Gender = 'Male') AS Male,
        (SELECT COUNT(*) FROM dbo.Employees WHERE IsActive = 1 AND Gender = 'Female') AS Female,
        (SELECT COUNT(*) FROM dbo.Employees WHERE IsActive = 1 AND Gender = 'Other') AS Other,
        (SELECT COUNT(*) FROM dbo.Employees WHERE IsActive = 1 AND Gender IS NULL) AS NotRecorded,
        (SELECT COUNT(*) FROM dbo.Employees WHERE IsActive = 0) AS Archived,
        (SELECT COUNT(*) FROM dbo.Employees
          WHERE IsActive = 1 AND JoiningDate >= DATEADD(DAY, -30, @today)) AS JoinedLast30Days,

        (SELECT COUNT(*) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
          WHERE d.IsActive = 1 AND e.IsActive = 1) AS DocTotal,

        (SELECT COUNT(*) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
          WHERE d.IsActive = 1 AND e.IsActive = 1 AND d.OriginalFilePath IS NOT NULL) AS DocReceived,

        (SELECT COUNT(*) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
          WHERE d.IsActive = 1 AND e.IsActive = 1 AND d.Status = 'Verified') AS DocVerified,

        (SELECT COUNT(*) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
          WHERE d.IsActive = 1 AND e.IsActive = 1 AND d.OriginalFilePath IS NULL) AS DocPending,

        (SELECT COUNT(*) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
          WHERE d.IsActive = 1 AND e.IsActive = 1
            AND d.OriginalFilePath IS NULL
            AND d.DueDate IS NOT NULL AND d.DueDate < @today) AS DocOverdue,

        (SELECT COUNT(*) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
          WHERE d.IsActive = 1 AND e.IsActive = 1
            AND d.OriginalFilePath IS NULL
            AND d.DueDate IS NOT NULL
            AND d.DueDate >= @today
            AND d.DueDate <= DATEADD(DAY, @dueSoonDays, @today)) AS DocDueSoon,

        (SELECT COUNT(DISTINCT d.EmployeeId) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
           INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
          WHERE d.IsActive = 1 AND e.IsActive = 1
            AND dt.IsMandatory = 1 AND d.OriginalFilePath IS NULL) AS MissingMandatory,

        (SELECT COUNT(*) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
          WHERE d.IsActive = 1 AND e.IsActive = 1
            AND d.SignatureStatus NOT IN ('NotRequired', 'Skipped', 'Added')) AS SignatureAwaiting,

        (SELECT COUNT(*) FROM dbo.Employees AS e
          WHERE e.IsActive = 1
            AND NOT EXISTS (SELECT 1 FROM dbo.EmployeeSignatures AS s
                             WHERE s.EmployeeId = e.EmployeeId AND s.IsActive = 1)) AS WithoutSignature
    `)

  const row = result.recordset[0]
  if (!row) throw new Error('Dashboard summary returned no row')

  return {
    employees: {
      total: row.Total,
      male: row.Male,
      female: row.Female,
      other: row.Other,
      notRecorded: row.NotRecorded,
      archived: row.Archived,
      joinedLast30Days: row.JoinedLast30Days,
    },
    documents: {
      total: row.DocTotal,
      received: row.DocReceived,
      verified: row.DocVerified,
      pending: row.DocPending,
      overdue: row.DocOverdue,
      dueSoon: row.DocDueSoon,
    },
    employeesMissingMandatory: row.MissingMandatory,
    signatures: {
      awaiting: row.SignatureAwaiting,
      employeesWithoutSignature: row.WithoutSignature,
    },
  }
}
