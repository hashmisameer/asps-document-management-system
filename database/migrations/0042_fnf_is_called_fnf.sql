/* =============================================================================
   ASPS-DMS  -  0042  The FNF document is called 'FNF'
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   0041 named it 'Full and Final Settlement'. HR calls it FNF, and the long
   name is too long for the checklist row, so the name shown is now 'FNF'.
   The code was always FNF and does not change.

   A new file rather than an edit to 0041: 0041 has run on the server and its
   checksum is in the ledger, and an applied migration is never edited. On a
   fresh database 0041 writes the long name and this file then shortens it,
   which ends where the server ends.

   This names the FNF row only and touches no other type, and no document -
   a checklist row reads its name from the type. It PRINTs whether it changed
   anything.
   ============================================================================= */

SET NOCOUNT ON;
GO

UPDATE dbo.DocumentTypes
   SET DocumentName = N'FNF',
       UpdatedAt    = SYSUTCDATETIME()
 WHERE DocumentCode = 'FNF'
   AND DocumentName <> N'FNF';

PRINT CONCAT('FNF: display name set to ''FNF'' on ', @@ROWCOUNT, ' document type row(s).');
GO
