/* =============================================================================
   ASPS-DMS  -  0041  Full and Final Settlement, a tenth document, set aside
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   FNF is the full and final settlement - whatever management holds for an
   employee who has left. It goes LAST on the checklist, and it is not chased:
   most employees will never have one, and the one whose arrives is somebody
   who has already gone.

   SO EVERY FNF ROW STARTS SET ASIDE. NotRequiredAt is set on it, which every
   count already reads (EXPECTED_DOCUMENT): the documents list, the reports,
   overdue, the dashboard, the daily reminder and the per-employee counter all
   leave it out with no new logic. It sits at the bottom of the checklist
   reading 'Not required'. For the employee whose FNF arrives, HR clicks 'Mark
   as required' and uploads, exactly as the ESIC form and PAN card work. No
   deadline: a document collected after somebody leaves has nothing to fall
   due against, and marking it required never computes one (setNotRequired
   leaves DueDate alone).

   The checklist itself is decided in shared/src/constants/documentChecklist.ts
   (see 0025); FNF is there with startsNotRequired and collectedAfterLeaving.
   This file writes the table to match, and gives the employees who already
   exist the row a new employee is now created with.

   -----------------------------------------------------------------------------
   CK_EmpDocs_NotRequired IS RELAXED - read this before tightening it back.

   0027 required NotRequiredBy whenever NotRequiredAt was set: every document
   set aside named the person who decided. An FNF row is set aside by the
   CHECKLIST, when the employee is created - nobody looked at that employee
   and decided. Writing a person's name there would put a decision on the
   record that nobody made: 630 rows today, and twenty to thirty more every
   day after. So NotRequiredBy may now be NULL beside NotRequiredAt, and that
   pair means exactly 'set aside by the checklist'. The checklist reads it as
   'Not required - mark as required when it arrives', with no name.

   What is still refused is a name with no date: NotRequiredBy without
   NotRequiredAt is nonsense. And the application, not the database, now
   guarantees the other half: a person who sets a document aside by hand is
   always recorded (employeeDocument.repository setNotRequired refuses
   without an actor, and a test fails if the actor is ever dropped).

   Restoring the old constraint would fail on every FNF row - and if the rows
   were changed to satisfy it, would put a name against each of them.
   -----------------------------------------------------------------------------

   Each step PRINTs what it changed. The rows are written for EVERY employee,
   archived and left included: FNF is precisely a leaver's document. An
   employee who somehow has an FNF row already is not given a second.
   ============================================================================= */

SET NOCOUNT ON;
GO

/* ---------------------------------------------------------------------------
   The constraint: a date may stand alone; a name may not.
   ------------------------------------------------------------------------ */
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_EmpDocs_NotRequired')
BEGIN
    ALTER TABLE dbo.EmployeeDocuments DROP CONSTRAINT CK_EmpDocs_NotRequired;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_EmpDocs_NotRequiredBy')
BEGIN
    ALTER TABLE dbo.EmployeeDocuments
        ADD CONSTRAINT CK_EmpDocs_NotRequiredBy CHECK (
            NotRequiredBy IS NULL OR NotRequiredAt IS NOT NULL
        );
END
GO

/* ---------------------------------------------------------------------------
   The type, last on the checklist.
   ------------------------------------------------------------------------ */
IF NOT EXISTS (SELECT 1 FROM dbo.DocumentTypes WHERE DocumentCode = 'FNF')
BEGIN
    INSERT INTO dbo.DocumentTypes
        (DocumentCode, DocumentName, IsMandatory, RequiresSignature,
         DeadlineValue, DeadlineUnit, SortOrder, RequiredFields, IsActive)
    VALUES
        ('FNF', N'Full and Final Settlement', 0, 0, NULL, NULL, 110, NULL, 1);
    PRINT 'FNF: document type added (sort order 110, last).';
END
ELSE
    PRINT 'FNF: document type already present.';
GO

/* Its settings, whether this file or the seed created it: not mandatory, no
   deadline, no signature, no identity check - and it may be marked required
   and set aside again, which is the whole point. */
UPDATE dbo.DocumentTypes
   SET DocumentName           = N'Full and Final Settlement',
       IsMandatory            = 0,
       RequiresSignature      = 0,
       DeadlineValue          = NULL,
       DeadlineUnit           = NULL,
       SortOrder              = 110,
       RequiredFields         = NULL,
       RecognitionKeywords    = NULL,
       RefuseOnCheckFailure   = 0,
       RequiredAtCreation     = 0,
       CanBeMarkedNotRequired = 1,
       IsActive               = 1,
       UpdatedAt              = SYSUTCDATETIME()
 WHERE DocumentCode = 'FNF';
GO

/* ---------------------------------------------------------------------------
   A set-aside FNF row for every employee who exists already. The same row a
   new employee is now created with: pending, no file, no deadline, no
   signature needed, set aside by the checklist - NotRequiredBy NULL.
   ------------------------------------------------------------------------ */
DECLARE @fnf INT = (SELECT DocumentTypeId FROM dbo.DocumentTypes WHERE DocumentCode = 'FNF');

INSERT INTO dbo.EmployeeDocuments
    (EmployeeId, DocumentTypeId, Status, SignatureStatus, DueDate, NotRequiredAt, NotRequiredBy)
SELECT e.EmployeeId, @fnf, 'Pending', 'NotRequired', NULL, SYSUTCDATETIME(), NULL
  FROM dbo.Employees AS e
 WHERE NOT EXISTS (
        SELECT 1 FROM dbo.EmployeeDocuments AS d
         WHERE d.EmployeeId = e.EmployeeId AND d.DocumentTypeId = @fnf AND d.IsActive = 1
       );

DECLARE @added INT = @@ROWCOUNT;
DECLARE @employees INT = (SELECT COUNT(*) FROM dbo.Employees);
DECLARE @withFnf INT = (
    SELECT COUNT(DISTINCT EmployeeId) FROM dbo.EmployeeDocuments
     WHERE DocumentTypeId = @fnf AND IsActive = 1
);

PRINT CONCAT('FNF: ', @added, ' row(s) written, set aside by the checklist. ',
             @withFnf, ' of ', @employees, ' employee(s) now have one.');
GO
