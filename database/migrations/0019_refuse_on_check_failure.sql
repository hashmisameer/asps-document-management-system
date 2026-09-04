/* =============================================================================
   ASPS-DMS  -  0019  Document types that are not kept when the check refuses them
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The office asked, on 2026-09-02, that an Aadhaar card or a PAN card whose name
   does not match the employee should not be uploaded at all.

   That needs saying explicitly now, because the reading no longer happens inside
   the upload. The file is stored first and read a few seconds later, so 'do not
   upload it' has to mean 'take it back off again' - the row goes back to
   Pending and the file is discarded, exactly as if the upload had not happened.

   A COLUMN rather than a list of document codes in the service. Which documents
   are treated this way is an office decision about paperwork, and the next one
   should be a row in this table, not a deployment.

   Set for the two identity cards only. Everywhere else a failed check stays on
   the record as 'Failed' for somebody to look at, which is what the office asked
   for on the gratuity form and the service card: those are the company's own
   forms, and a name that will not read off a photocopy is a reason to look, not
   a reason to throw the document away.

   THE HUMAN PATH IS DELIBERATELY LEFT OPEN. An upload that carries a reason is
   kept whatever the reading says. Without that, a card this system cannot read -
   and the office's own PAN card is one, its name coming back as 'HHAGWAN SINGH'
   under every setting tried - could never be attached at all, and both cards are
   required before an employee can be created.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF COL_LENGTH(N'dbo.DocumentTypes', N'RefuseOnCheckFailure') IS NULL
BEGIN
    ALTER TABLE dbo.DocumentTypes
        ADD RefuseOnCheckFailure BIT NOT NULL
            CONSTRAINT DF_DocTypes_RefuseOnCheckFailure DEFAULT (0);
END
GO

UPDATE dbo.DocumentTypes
   SET RefuseOnCheckFailure = 1, UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode IN ('AADHAAR_CARD', 'PAN_CARD');
GO
