/* =============================================================================
   ASPS-DMS  -  0028  Which document types may be marked 'not required'
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   0027 gave every checklist row a way to be set aside for one employee, which
   was right for ESIC and much too wide for everything else. PAN, Form 16 and
   the appointment letter are statutory: nobody at this company decides they do
   not apply to somebody, and a single mis-click on the wrong row would take a
   document off an employee's file and out of every count with nothing to say it
   had happened.

   A COLUMN RATHER THAN A LIST IN THE CODE, for the same reason
   RefuseOnCheckFailure is one: which documents these are is an office decision
   about paperwork, and the next one - PF, when the office asks - should be an
   UPDATE rather than a deployment.

   Default 0, so every type is closed until somebody opens it. ESIC only, today.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF COL_LENGTH(N'dbo.DocumentTypes', N'CanBeMarkedNotRequired') IS NULL
BEGIN
    ALTER TABLE dbo.DocumentTypes
        ADD CanBeMarkedNotRequired BIT NOT NULL
            CONSTRAINT DF_DocTypes_CanBeMarkedNotRequired DEFAULT (0);
END
GO

UPDATE dbo.DocumentTypes
   SET CanBeMarkedNotRequired = 1, UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode = 'ESIC_FORM';
GO

/* Everything else is closed, including any type added since. Written out rather
   than left to the default so that re-running this file puts the table back to
   the office's decision whatever has happened in between. */
UPDATE dbo.DocumentTypes
   SET CanBeMarkedNotRequired = 0, UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode <> 'ESIC_FORM' AND CanBeMarkedNotRequired = 1;
GO
