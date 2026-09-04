/* =============================================================================
   ASPS-DMS  -  0018  The identity check runs after the upload, not inside it
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   Reading a document takes between four and sixty seconds. Until now that
   happened INSIDE the upload request and before the file was written, so
   whoever pressed Upload watched a spinner for the whole of it - one measured
   request sat open for 62 seconds - and learned to assume the system had hung.

   The check now runs after the file is safely stored, and the row carries the
   answer when it arrives. Two new states follow from that:

     'Checking'  the file is in and the reading has not finished yet.
     'Failed'    the reading finished and the document did not match.

   0003 said, correctly for how it worked then, that 'Failed' is never a stored
   state - a failed check refused the upload, so there was no row to record it
   against. That is what has changed. The document is now stored first and
   judged second, which means a refusal has somewhere to live, and the person
   accepting it with a reason is accepting a document that already exists rather
   than uploading it again.

   The constraint below REPLACES the one from 0003. Nothing is lost: every value
   it allowed is still allowed.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_EmpDocs_IdentityCheck')
    ALTER TABLE dbo.EmployeeDocuments DROP CONSTRAINT CK_EmpDocs_IdentityCheck;
GO

ALTER TABLE dbo.EmployeeDocuments
    ADD CONSTRAINT CK_EmpDocs_IdentityCheck CHECK (
        IdentityCheckStatus IS NULL
        OR IdentityCheckStatus IN ('Passed', 'Overridden', 'NotChecked', 'Checking', 'Failed')
    );
GO

/* Finding the documents still being read, so a restart can pick them up rather
   than leaving a row saying 'Checking' for ever.
   NOT a filtered index, deliberately. A filtered index on this table would
   require QUOTED_IDENTIFIER ON for every INSERT and UPDATE against it, which is
   a condition this application's driver does not guarantee - one on dbo.Users
   had to be removed for exactly that reason. An ordinary index on a column with
   five values is enough for a lookup that runs once at startup. */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_EmpDocs_IdentityCheckStatus' AND object_id = OBJECT_ID(N'dbo.EmployeeDocuments'))
    CREATE NONCLUSTERED INDEX IX_EmpDocs_IdentityCheckStatus
        ON dbo.EmployeeDocuments (IdentityCheckStatus)
        INCLUDE (EmployeeId, DocumentTypeId, OriginalFilePath);
GO
