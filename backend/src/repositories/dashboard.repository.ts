import { createRequest, sql } from '../database/pool.js'
import { DOCUMENT_STATUS, todayDateOnly } from '@asps-dms/shared'
import {
  COUNTABLE_DOCUMENT,
  COUNTABLE_EMPLOYEE,
  IDENTITY_CARD_CODES_SQL,
} from './employeeScope.js'

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
    /**
     * Everybody the company has employed: active plus left, archived excluded.
     *
     * Archived records are not people who worked here - they are the entries
     * the office has struck out, the mistakes and the duplicates - so counting
     * them would inflate the one number somebody would quote outside the
     * building.
     *
     * Exactly `total` + `left`, and it has to stay that way: those two are the
     * tiles either side of it on the screen.
     */
    activeAndLeft: number
    joinedLast30Days: number
    /**
     * Employees who have left, and how many left this calendar year.
     *
     * Separate from `archived`, which is about the record rather than the
     * person. `total` above counts only those still here, so the two never
     * double-count anybody.
     *
     * Archived records are excluded here as they are everywhere else on this
     * dashboard. They used not to be, which made 'have left in total' the one
     * number on the page counting records the office had struck out - and, once
     * a Total tile sat beside it, the one that stopped the section adding up.
     */
    left: number
    leftThisYear: number
  }
  documents: {
    total: number
    received: number
    verified: number
    pending: number
    overdue: number
    dueSoon: number
  }
  /**
   * Active employees by whether their checklist is finished.
   *
   * EMPLOYEES, not document rows. The section used to count rows - 'Still to
   * come 57' - which is a number nobody can act on: it does not say how many
   * people to go and find, and 57 rows can be five employees or fifty.
   *
   * EVERY document on the checklist counts, optional ones included: an employee
   * is complete when there is nothing left to collect from them, and 'optional'
   * describes whether the document must be chased, not whether it is on the
   * list.
   *
   * The two partition the active employees, so they always add up to
   * `employees.total`. An employee with no checklist rows at all counts as
   * complete - there is nothing outstanding - which cannot normally arise,
   * because a checklist is materialised with the record.
   */
  checklists: {
    complete: number
    incomplete: number
  }
  /**
   * Active employees still missing one of the two IDENTITY CARDS.
   *
   * Not 'a mandatory document', which is what this counted until eight of the
   * ten became mandatory - at which point it was very nearly the Incomplete
   * card next to it, saying the same thing in a way nobody could act on
   * differently.
   */
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
  ActiveAndLeft: number
  JoinedLast30Days: number
  Left: number
  LeftThisYear: number
  DocTotal: number
  DocReceived: number
  DocVerified: number
  DocPending: number
  DocOverdue: number
  DocDueSoon: number
  ChecklistComplete: number
  ChecklistIncomplete: number
  MissingMandatory: number
  SignatureAwaiting: number
  WithoutSignature: number
}

export async function getSummary(dueSoonDays: number): Promise<DashboardSummary> {
  const request = await createRequest()
  const result = await request
    .input('today', sql.Date, new Date(`${todayDateOnly()}T00:00:00.000Z`))
    /* The three statuses that mean a file arrived and was not rejected. Bound
       under the same names the employee list binds them, so the predicate is
       the same TEXT on both sides and not merely the same idea. */
    .input('stUploaded', sql.VarChar(20), DOCUMENT_STATUS.UPLOADED)
    .input('stUnderReview', sql.VarChar(20), DOCUMENT_STATUS.UNDER_REVIEW)
    .input('stVerified', sql.VarChar(20), DOCUMENT_STATUS.VERIFIED)
    .input('dueSoonDays', sql.Int, dueSoonDays).query<Row>(`
      SELECT
        (SELECT COUNT(*) FROM dbo.Employees AS e WHERE ${COUNTABLE_EMPLOYEE}) AS Total,
        (SELECT COUNT(*) FROM dbo.Employees AS e WHERE ${COUNTABLE_EMPLOYEE} AND e.Gender = 'Male') AS Male,
        (SELECT COUNT(*) FROM dbo.Employees AS e WHERE ${COUNTABLE_EMPLOYEE} AND e.Gender = 'Female') AS Female,
        (SELECT COUNT(*) FROM dbo.Employees AS e WHERE ${COUNTABLE_EMPLOYEE} AND e.Gender = 'Other') AS Other,
        (SELECT COUNT(*) FROM dbo.Employees AS e WHERE ${COUNTABLE_EMPLOYEE} AND e.Gender IS NULL) AS NotRecorded,
        (SELECT COUNT(*) FROM dbo.Employees WHERE IsActive = 0) AS Archived,

        /* Everybody the company has actually employed: those still here and
           those who have gone, with the archived records left out.

           IsActive = 1 alone, because 'still here' and 'has left' partition it -
           which is what makes this the sum of the two tiles beside it rather
           than a third number nobody can reconcile. */
        (SELECT COUNT(*) FROM dbo.Employees WHERE IsActive = 1) AS ActiveAndLeft,

        (SELECT COUNT(*) FROM dbo.Employees
          WHERE IsActive = 1
            AND LastWorkingDate IS NOT NULL AND LastWorkingDate < @today) AS [Left],
        (SELECT COUNT(*) FROM dbo.Employees
          WHERE IsActive = 1
            AND LastWorkingDate IS NOT NULL
            AND LastWorkingDate < @today
            AND YEAR(LastWorkingDate) = YEAR(@today)) AS LeftThisYear,
        /* Somebody who joined three weeks ago and has already gone is not a
           recent joiner the office can do anything about, so this reads the
           same scope as everything else. */
        (SELECT COUNT(*) FROM dbo.Employees AS e
          WHERE ${COUNTABLE_EMPLOYEE} AND e.JoiningDate >= DATEADD(DAY, -30, @today)) AS JoinedLast30Days,

        (SELECT COUNT(*) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
          WHERE ${COUNTABLE_DOCUMENT}) AS DocTotal,

        (SELECT COUNT(*) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
          WHERE ${COUNTABLE_DOCUMENT} AND d.OriginalFilePath IS NOT NULL) AS DocReceived,

        (SELECT COUNT(*) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
          WHERE ${COUNTABLE_DOCUMENT} AND d.Status = 'Verified') AS DocVerified,

        (SELECT COUNT(*) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
          WHERE ${COUNTABLE_DOCUMENT} AND d.OriginalFilePath IS NULL) AS DocPending,

        (SELECT COUNT(*) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
          WHERE ${COUNTABLE_DOCUMENT}
            AND d.OriginalFilePath IS NULL
            AND d.DueDate IS NOT NULL AND d.DueDate < @today) AS DocOverdue,

        (SELECT COUNT(*) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
          WHERE ${COUNTABLE_DOCUMENT}
            AND d.OriginalFilePath IS NULL
            AND d.DueDate IS NOT NULL
            AND d.DueDate >= @today
            AND d.DueDate <= DATEADD(DAY, @dueSoonDays, @today)) AS DocDueSoon,

        /* Employees whose checklist is finished, and employees whose is not.

           OUTSTANDING is written exactly as the employee list writes it - a row
           whose status is not one of the three that mean a file arrived and was
           not rejected - so a card and the list it opens can never disagree
           about who is complete.

           EXISTS and NOT EXISTS over the same condition, so the two partition
           the active employees and always add up to Total.

           NotRequiredAt is applied by hand here. These two write their own
           scope rather than reading COUNTABLE_DOCUMENT, which makes them the
           second of the two places that has to remember - an employee whose
           only gap is an ESIC form nobody expects of them is complete. */
        (SELECT COUNT(*) FROM dbo.Employees AS e
          WHERE ${COUNTABLE_EMPLOYEE}
            AND NOT EXISTS (SELECT 1 FROM dbo.EmployeeDocuments AS d
                             WHERE d.EmployeeId = e.EmployeeId AND d.IsActive = 1 AND d.NotRequiredAt IS NULL
                               AND d.Status NOT IN (@stUploaded, @stUnderReview, @stVerified))) AS ChecklistComplete,

        (SELECT COUNT(*) FROM dbo.Employees AS e
          WHERE ${COUNTABLE_EMPLOYEE}
            AND EXISTS (SELECT 1 FROM dbo.EmployeeDocuments AS d
                         WHERE d.EmployeeId = e.EmployeeId AND d.IsActive = 1 AND d.NotRequiredAt IS NULL
                           AND d.Status NOT IN (@stUploaded, @stUnderReview, @stVerified))) AS ChecklistIncomplete,

        (SELECT COUNT(DISTINCT d.EmployeeId) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
           INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
          WHERE ${COUNTABLE_DOCUMENT}
            AND dt.DocumentCode IN (${IDENTITY_CARD_CODES_SQL})
            AND d.OriginalFilePath IS NULL) AS MissingMandatory,

        (SELECT COUNT(*) FROM dbo.EmployeeDocuments AS d
           INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
          WHERE ${COUNTABLE_DOCUMENT}
            AND d.SignatureStatus NOT IN ('NotRequired', 'Skipped', 'Added')) AS SignatureAwaiting,

        (SELECT COUNT(*) FROM dbo.Employees AS e
          WHERE ${COUNTABLE_EMPLOYEE}
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
      activeAndLeft: row.ActiveAndLeft,
      joinedLast30Days: row.JoinedLast30Days,
      left: row.Left,
      leftThisYear: row.LeftThisYear,
    },
    documents: {
      total: row.DocTotal,
      received: row.DocReceived,
      verified: row.DocVerified,
      pending: row.DocPending,
      overdue: row.DocOverdue,
      dueSoon: row.DocDueSoon,
    },
    checklists: {
      complete: row.ChecklistComplete,
      incomplete: row.ChecklistIncomplete,
    },
    employeesMissingMandatory: row.MissingMandatory,
    signatures: {
      awaiting: row.SignatureAwaiting,
      employeesWithoutSignature: row.WithoutSignature,
    },
  }
}
