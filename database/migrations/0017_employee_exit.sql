/* =============================================================================
   ASPS-DMS  -  0017  Resignation and exit
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   Recording that an employee has left, and when.

   TWO DATES, NOT ONE. Somebody resigns on the 1st and works until the 30th, and
   for those thirty days they are still employed: still paid, still on the
   checklist, still chased for a missing form. The status turns only when the
   last working date has passed, so ResignationDate is when they said and
   LastWorkingDate is when it takes effect.

   EMPLOYMENT STATUS IS NOT IsActive. The office asked to reuse an existing
   employment status column; there isn't one. IsActive is this system's ARCHIVE
   flag - it is what setArchived writes and what the dashboard counts as
   'archived' - and leaving the company is not the same as an employee record
   being put away. Someone who has left is still looked at, reported on and kept
   for years; an archived record is one the office has finished with. Conflating
   them would mean every exit hid the employee from the list, and every archive
   claimed somebody had resigned. So this is its own column.

   NOTHING IS DELETED, here or by the code that uses it. Provident fund, ESIC
   and gratuity records have to be produced years later, and the person they
   belong to has usually left by then - which makes the leavers the rows most
   worth keeping, not least.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF COL_LENGTH(N'dbo.Employees', N'EmploymentStatus') IS NULL
BEGIN
    /* Every existing row is ACTIVE. The 568 employees already on file have not
       left; they were entered before anyone could say so either way. */
    ALTER TABLE dbo.Employees
        ADD EmploymentStatus VARCHAR(10) NOT NULL
            CONSTRAINT DF_Employees_EmploymentStatus DEFAULT ('ACTIVE');
END
GO

IF COL_LENGTH(N'dbo.Employees', N'ResignationDate') IS NULL
    ALTER TABLE dbo.Employees ADD ResignationDate DATE NULL;
GO

IF COL_LENGTH(N'dbo.Employees', N'LastWorkingDate') IS NULL
    ALTER TABLE dbo.Employees ADD LastWorkingDate DATE NULL;
GO

IF COL_LENGTH(N'dbo.Employees', N'ExitReason') IS NULL
    ALTER TABLE dbo.Employees ADD ExitReason VARCHAR(20) NULL;
GO

IF COL_LENGTH(N'dbo.Employees', N'ExitNotes') IS NULL
    ALTER TABLE dbo.Employees ADD ExitNotes NVARCHAR(1000) NULL;
GO

/* -----------------------------------------------------------------------------
   The rules, in the database as well as in the code.

   The service checks these too and returns a readable message; these are here so
   that no route into the table - a fix applied by hand at the console, a future
   import - can leave a row saying somebody's last day came before they resigned,
   or before they were hired.
   -------------------------------------------------------------------------- */

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_Employees_EmploymentStatus')
    ALTER TABLE dbo.Employees ADD CONSTRAINT CK_Employees_EmploymentStatus
        CHECK (EmploymentStatus IN ('ACTIVE', 'LEFT'));
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_Employees_ExitReason')
    ALTER TABLE dbo.Employees ADD CONSTRAINT CK_Employees_ExitReason
        CHECK (ExitReason IS NULL OR ExitReason IN ('RESIGNED', 'TERMINATED', 'RETIRED', 'ABSCONDING'));
GO

/* The last working day is not before the resignation. */
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_Employees_LastWorkingAfterResignation')
    ALTER TABLE dbo.Employees ADD CONSTRAINT CK_Employees_LastWorkingAfterResignation
        CHECK (ResignationDate IS NULL OR LastWorkingDate IS NULL OR LastWorkingDate >= ResignationDate);
GO

/* Neither date is before the employee was hired. */
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_Employees_ExitAfterJoining')
    ALTER TABLE dbo.Employees ADD CONSTRAINT CK_Employees_ExitAfterJoining
        CHECK ((ResignationDate IS NULL OR ResignationDate >= JoiningDate)
           AND (LastWorkingDate IS NULL OR LastWorkingDate >= JoiningDate));
GO

/* A row that says LEFT says when. Without this an exit could be recorded with no
   last working date, and the deadline suppression - which keys off that date -
   would go on chasing somebody who had gone. */
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_Employees_LeftHasDates')
    ALTER TABLE dbo.Employees ADD CONSTRAINT CK_Employees_LeftHasDates
        CHECK (EmploymentStatus <> 'LEFT' OR (ResignationDate IS NOT NULL AND LastWorkingDate IS NOT NULL AND ExitReason IS NOT NULL));
GO

/* The employee list filters on this, and the dashboard counts by it. */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Employees_EmploymentStatus' AND object_id = OBJECT_ID(N'dbo.Employees'))
    CREATE NONCLUSTERED INDEX IX_Employees_EmploymentStatus
        ON dbo.Employees (EmploymentStatus) INCLUDE (EmployeeCode, EmployeeName, LastWorkingDate);
GO
