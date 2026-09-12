/* =============================================================================
   ASPS-DMS  -  0029  The Service Card is retired
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The office no longer collects the Service Card. Nine documents remain, and
   this is all of them:

     Appointment Letter    mandatory   7 days
     Bio Data Form         mandatory   7 days
     Aadhaar Card          mandatory   no deadline
     PAN Card              mandatory   no deadline
     PF Form               optional    no deadline
     ESIC Form             optional    no deadline
     Payment of Gratuity   mandatory   7 days
     Form No. 16           mandatory   7 days
     Confirmation Letter   mandatory   6 months

   It is deactivated rather than deleted, exactly as 0024 retired Bank Proof: a
   document type row is pointed at by every checklist row ever created against
   it, and deleting it would orphan any file somebody has already uploaded and
   break the audit trail that says who uploaded it. The checklist rows are
   deactivated the same way and for the same reason - nothing is removed and no
   file is touched, it simply stops being counted, chased or shown.

   THE CHECKLIST ROWS FIRST. They are what the screens read: every count, list,
   report and dashboard tile scopes on EmployeeDocuments.IsActive, and only the
   reminder email looks at the type's own flag. Retiring the type alone would
   leave the Service Card on every employee's list, overdue, with its type
   retired underneath it.

   Rows that already hold a file go the same way. The file stays on disk and
   the row stays in the table, so what was uploaded and by whom is still
   answerable; it is no longer offered on any screen.

   The code is changed with this migration: SERVICE_CARD leaves the seed and
   shared/src/constants/documentChecklist.ts, so a fresh database never grows
   it back and the application stops describing a document the office does
   not keep.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF EXISTS (SELECT 1 FROM dbo.DocumentTypes WHERE DocumentCode = 'SERVICE_CARD')
BEGIN
    /* The checklist rows first. They are what the screens read; leaving them
       active would keep the Service Card on every employee's list with its
       type retired underneath it. */
    UPDATE d
       SET d.IsActive  = 0,
           d.UpdatedAt = SYSUTCDATETIME()
      FROM dbo.EmployeeDocuments AS d
     INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
     WHERE d.IsActive = 1
       AND dt.DocumentCode = 'SERVICE_CARD';

    UPDATE dbo.DocumentTypes
       SET IsActive  = 0,
           UpdatedAt = SYSUTCDATETIME()
     WHERE IsActive = 1
       AND DocumentCode = 'SERVICE_CARD';
END
GO
