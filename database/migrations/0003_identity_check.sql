/* =============================================================================
   ASPS-DMS  -  0003  Employee identity details, and the document identity check
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   An uploaded document is now read and compared with the employee's own record,
   so a form belonging to one person cannot be filed against another. That needs
   two things this schema did not have:

     1. The details to compare against. The record held five things - code, name,
        joining date, department and designation - and the forms carry nine more.
        A phone number cannot be checked against a record that does not know it.

     2. Somewhere to keep what the check found, including an override. A refusal
        that can be overridden but not RECORDED is not a control at all: the
        whole value of the block is that going around it leaves a mark.

   Every new employee column is NULLABLE. Employees already on file predate
   these fields, and a NOT NULL column would either block the migration or
   invent a value for a real person. A field the office has not recorded is
   reported as such by the check, and is never treated as a document at fault.

   Follows 0001's constraints: no 2016+ syntax, no JSON functions, no
   DROP ... IF EXISTS. Verification detail is NVARCHAR(MAX) JSON parsed in Node,
   exactly as dbo.AuditLogs.Metadata is.
   ============================================================================= */

SET NOCOUNT ON;
GO

/* -----------------------------------------------------------------------------
   Employees - the details the company's forms actually carry
   -------------------------------------------------------------------------- */
IF COL_LENGTH(N'dbo.Employees', N'PhoneNumber') IS NULL
BEGIN
    ALTER TABLE dbo.Employees ADD PhoneNumber VARCHAR(20) NULL;
END
GO

IF COL_LENGTH(N'dbo.Employees', N'DateOfBirth') IS NULL
BEGIN
    /* DATE, like JoiningDate: a birthday is a calendar day, and storing it as
       an instant would let a timezone conversion move it. */
    ALTER TABLE dbo.Employees ADD DateOfBirth DATE NULL;
END
GO

IF COL_LENGTH(N'dbo.Employees', N'PostAppliedFor') IS NULL
BEGIN
    /* Kept apart from Designation on purpose: the post someone applied for is
       what the bio data form says, and it is not always the post they now hold. */
    ALTER TABLE dbo.Employees ADD PostAppliedFor NVARCHAR(100) NULL;
END
GO

IF COL_LENGTH(N'dbo.Employees', N'CategoryOfWorkmen') IS NULL
BEGIN
    ALTER TABLE dbo.Employees ADD CategoryOfWorkmen NVARCHAR(100) NULL;
END
GO

IF COL_LENGTH(N'dbo.Employees', N'AadhaarNumber') IS NULL
BEGIN
    /* Aadhaar and PAN are the most sensitive values in this database. They are
       stored because the service card check compares them, and they are never
       written to a log or to audit metadata - AUDIT_REDACTED_KEYS covers both -
       never returned in a list response, and never shown to a role that cannot
       already read the document itself. The volume holding this database and
       its backups needs the same care as the document store (Q12). */
    ALTER TABLE dbo.Employees ADD AadhaarNumber VARCHAR(20) NULL;
END
GO

IF COL_LENGTH(N'dbo.Employees', N'PanNumber') IS NULL
BEGIN
    ALTER TABLE dbo.Employees ADD PanNumber VARCHAR(10) NULL;
END
GO

IF COL_LENGTH(N'dbo.Employees', N'UanNumber') IS NULL
BEGIN
    ALTER TABLE dbo.Employees ADD UanNumber VARCHAR(20) NULL;
END
GO

IF COL_LENGTH(N'dbo.Employees', N'EsiNumber') IS NULL
BEGIN
    ALTER TABLE dbo.Employees ADD EsiNumber VARCHAR(25) NULL;
END
GO

IF COL_LENGTH(N'dbo.Employees', N'AppointmentLetterDate') IS NULL
BEGIN
    ALTER TABLE dbo.Employees ADD AppointmentLetterDate DATE NULL;
END
GO

/* -----------------------------------------------------------------------------
   DocumentTypes.RequiredFields
   Which employee details this document must confirm, as a comma-separated list
   of field codes - 'EmployeeName,EmployeeCode,JoiningDate'.

   A list in a column rather than a child table, because it is read whole every
   single time and never queried across: nothing ever asks "which document types
   check a phone number". A join table would be three more files and one more
   round trip to express the same thing. The codes are validated in Node against
   DOCUMENT_FIELDS, so an unknown one cannot be quietly ignored.

   NULL means this document type is not checked at all.
   -------------------------------------------------------------------------- */
IF COL_LENGTH(N'dbo.DocumentTypes', N'RequiredFields') IS NULL
BEGIN
    ALTER TABLE dbo.DocumentTypes ADD RequiredFields NVARCHAR(400) NULL;
END
GO

/* -----------------------------------------------------------------------------
   EmployeeDocuments - what the check found, and any override of it

   The result is kept on the document rather than only in the audit log because
   it is part of what the document IS: months later, "this service card was
   accepted although its Aadhaar number could not be read" has to be visible on
   the record, not reconstructed from a log by someone who knows to look.
   -------------------------------------------------------------------------- */
IF COL_LENGTH(N'dbo.EmployeeDocuments', N'IdentityCheckStatus') IS NULL
BEGIN
    ALTER TABLE dbo.EmployeeDocuments ADD IdentityCheckStatus VARCHAR(20) NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_EmpDocs_IdentityCheck')
BEGIN
    /* NULL for a document uploaded before this existed, or one whose type is
       not checked. 'Failed' is never a stored state: a failed check refuses the
       upload, so there is no document to record it against. */
    ALTER TABLE dbo.EmployeeDocuments
        ADD CONSTRAINT CK_EmpDocs_IdentityCheck CHECK (
            IdentityCheckStatus IS NULL
            OR IdentityCheckStatus IN ('Passed', 'Overridden', 'NotChecked')
        );
END
GO

IF COL_LENGTH(N'dbo.EmployeeDocuments', N'IdentityCheckSource') IS NULL
BEGIN
    /* 'PdfText', 'Ocr' or 'None'. Worth keeping: text lifted from a PDF's own
       text layer is exactly what the file says, while text read off a scan is a
       reading of it, and that difference matters when a result is questioned. */
    ALTER TABLE dbo.EmployeeDocuments ADD IdentityCheckSource VARCHAR(10) NULL;
END
GO

IF COL_LENGTH(N'dbo.EmployeeDocuments', N'IdentityCheckDetail') IS NULL
BEGIN
    /* Per-field outcomes as JSON, parsed in Node - SQL 2014 has no JSON support.
       Holds which fields were checked and how each came out. It never holds the
       document's text: that is the employee's document, and a copy of it in a
       column is a second place it has to be protected. */
    ALTER TABLE dbo.EmployeeDocuments ADD IdentityCheckDetail NVARCHAR(MAX) NULL;
END
GO

IF COL_LENGTH(N'dbo.EmployeeDocuments', N'IdentityCheckedAt') IS NULL
BEGIN
    ALTER TABLE dbo.EmployeeDocuments ADD IdentityCheckedAt DATETIME2(3) NULL;
END
GO

IF COL_LENGTH(N'dbo.EmployeeDocuments', N'IdentityOverrideBy') IS NULL
BEGIN
    ALTER TABLE dbo.EmployeeDocuments ADD IdentityOverrideBy INT NULL;
END
GO

IF COL_LENGTH(N'dbo.EmployeeDocuments', N'IdentityOverrideReason') IS NULL
BEGIN
    ALTER TABLE dbo.EmployeeDocuments ADD IdentityOverrideReason NVARCHAR(500) NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_EmpDocs_IdentityOverrideBy')
BEGIN
    ALTER TABLE dbo.EmployeeDocuments
        ADD CONSTRAINT FK_EmpDocs_IdentityOverrideBy FOREIGN KEY (IdentityOverrideBy)
            REFERENCES dbo.Users (UserId);
END
GO

/* An override without a name and a reason is not an override, it is a hole.
   The database enforces that, not only the service that writes it. */
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_EmpDocs_IdentityOverride')
BEGIN
    ALTER TABLE dbo.EmployeeDocuments
        ADD CONSTRAINT CK_EmpDocs_IdentityOverride CHECK (
            IdentityCheckStatus <> 'Overridden'
            OR (IdentityOverrideBy IS NOT NULL AND IdentityOverrideReason IS NOT NULL)
        );
END
GO
