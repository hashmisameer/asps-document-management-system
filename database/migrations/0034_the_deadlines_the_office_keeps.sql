/* =============================================================================
   ASPS-DMS  -  0034  The deadlines the office now keeps
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The office has revised how long people have to bring each document. All
   nine count from the joining date, as before; every one of them now has a
   deadline:

     Appointment Letter    7 days     unchanged
     Bio Data Form         7 days     unchanged
     Aadhaar Card          7 days     had none
     PAN Card              7 days     had none
     PF Form / Form 11    12 days     had none
     ESIC Form            12 days     had none
     Payment of Gratuity  12 days     was 7
     Form No. 16          12 days     was 7
     Confirmation Letter   6 months   unchanged, and not named below

   THE MANDATORY FLAGS DO NOT CHANGE. PF and ESIC stay optional - they are
   filed with the government, not collected from the employee - and simply
   have a date now. IsMandatory is not touched here.

   THE DECISION IS IN THE CODE. shared/src/constants/documentChecklist.ts is
   what a new employee's checklist is built from, and it changes in the same
   deployment as this file; the columns below are kept in step with it, as
   0025 established, so that SQL which reads them agrees with the application.

   THE ROWS ALREADY THERE, OUTSTANDING ONLY. The office wants the documents
   still owed to be chased, so every checklist row with no file attached gets
   the new date, computed from that employee's joining date. A row that has a
   file keeps whatever date applied when the document came in - 0024's rule,
   applied in reverse: a settings change does not rewrite history.

   THE OVERDUE COUNT WILL ROUGHLY DOUBLE, at once, and that is the intended
   outcome. Aadhaar, PAN, PF and ESIC could never be overdue because they had
   no deadline; most outstanding rows for them are older than a fortnight.

   THIS IS ONE-WAY. Nothing in the application clears a due date - a document
   marked 'not required' is hidden from the counts, but its date stays - so
   undoing this would need another migration, written the way 0024 wrote its
   clearing step. Go in knowing that.

   The history, for whoever reads this next: 0022 gave the two identity cards
   seven days; 0023 backfilled that; 0024 took it away again at the office's
   request three days later; this gives it back, and adds the four other
   changes above.

   Idempotent: every UPDATE carries its target value in its WHERE, so a
   second run touches nothing.
   ============================================================================= */

SET NOCOUNT ON;
GO

/* ---------------------------------------------------------------------------
   1. The types - what a new employee's checklist is built from
   ------------------------------------------------------------------------ */

UPDATE dbo.DocumentTypes
   SET DeadlineValue = 7,
       DeadlineUnit  = 'DAY',
       UpdatedAt     = SYSUTCDATETIME()
 WHERE DocumentCode IN ('AADHAAR_CARD', 'PAN_CARD')
   AND (ISNULL(DeadlineValue, -1) <> 7 OR ISNULL(DeadlineUnit, '') <> 'DAY');
GO

UPDATE dbo.DocumentTypes
   SET DeadlineValue = 12,
       DeadlineUnit  = 'DAY',
       UpdatedAt     = SYSUTCDATETIME()
 WHERE DocumentCode IN ('FORM_16', 'GRATUITY_FORM', 'PF_FORM', 'ESIC_FORM')
   AND (ISNULL(DeadlineValue, -1) <> 12 OR ISNULL(DeadlineUnit, '') <> 'DAY');
GO

/* ---------------------------------------------------------------------------
   2. The rows already there - outstanding only

   d.IsActive = 1 : the current row for each type, not one superseded by a
                    replacement.
   OriginalFilePath IS NULL : nothing has been attached. A document that has
                    arrived keeps the date that applied to it.
   ------------------------------------------------------------------------ */

UPDATE d
   SET d.DueDate   = DATEADD(DAY, 7, e.JoiningDate),
       d.UpdatedAt = SYSUTCDATETIME()
  FROM dbo.EmployeeDocuments AS d
 INNER JOIN dbo.Employees     AS e  ON e.EmployeeId = d.EmployeeId
 INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
 WHERE d.IsActive = 1
   AND d.OriginalFilePath IS NULL
   AND dt.DocumentCode IN ('AADHAAR_CARD', 'PAN_CARD')
   AND (d.DueDate IS NULL OR d.DueDate <> DATEADD(DAY, 7, e.JoiningDate));
GO

UPDATE d
   SET d.DueDate   = DATEADD(DAY, 12, e.JoiningDate),
       d.UpdatedAt = SYSUTCDATETIME()
  FROM dbo.EmployeeDocuments AS d
 INNER JOIN dbo.Employees     AS e  ON e.EmployeeId = d.EmployeeId
 INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
 WHERE d.IsActive = 1
   AND d.OriginalFilePath IS NULL
   AND dt.DocumentCode IN ('FORM_16', 'GRATUITY_FORM', 'PF_FORM', 'ESIC_FORM')
   AND (d.DueDate IS NULL OR d.DueDate <> DATEADD(DAY, 12, e.JoiningDate));
GO
