/* =============================================================================
   ASPS-DMS  -  0031  The PF form, spelt the way the rest of the list is
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   0030 renamed the row 'PF FORM/FORM 11'. The office's spelling is
   'PF Form / Form 11' - title case, a space either side of the slash - which
   is how every other name on the checklist is written: Bio Data Form, Payment
   of Gratuity, Confirmation Letter. One name in capitals in a list of nine
   reads as a different kind of thing, and it is not.

   THE NAME ONLY, as in 0030. The code stays PF_FORM and the recognition
   phrases are left alone.

   Guarded on the name 0030 wrote, so a second run touches nothing and a name
   the office has since changed by hand is not put back.
   ============================================================================= */

SET NOCOUNT ON;
GO

UPDATE dbo.DocumentTypes
   SET DocumentName = N'PF Form / Form 11',
       UpdatedAt    = SYSUTCDATETIME()
 WHERE DocumentCode = 'PF_FORM'
   AND DocumentName = N'PF FORM/FORM 11';
GO
