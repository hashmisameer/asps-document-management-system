/* =============================================================================
   ASPS-DMS  -  0030  The PF form, under the name it is actually printed
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The office calls this document 'PF FORM/FORM 11', and so does the document:
   it is Form 11 under the Employees' Provident Funds Scheme, the nomination
   and declaration a new joiner fills in. 'PF Form' was this system's own
   shortening and appears on no piece of paper anybody in the office is holding.

   THE NAME ONLY. The code stays PF_FORM - it is what every checklist row, every
   report and the constant in shared/src/constants/documentChecklist.ts key on -
   and the recognition phrases are left exactly as 0011 wrote them: 'FORM 11' is
   already among them, so the OCR check was never reading the display name.

   Guarded on the current name rather than run blind, so a second run touches
   nothing and a name the office has since changed by hand is not put back.
   ============================================================================= */

SET NOCOUNT ON;
GO

UPDATE dbo.DocumentTypes
   SET DocumentName = N'PF FORM/FORM 11',
       UpdatedAt    = SYSUTCDATETIME()
 WHERE DocumentCode = 'PF_FORM'
   AND DocumentName = N'PF Form';
GO
