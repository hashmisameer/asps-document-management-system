/* =============================================================================
   ASPS-DMS  -  0014  Form No. 16 is checked for the name, and nothing else
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The office asked, on 2026-09-02, that Form No. 16 be accepted when the
   employee's name is found in it.

   Two checks ran on this document and only one of them was wanted. The field
   check looks for the name; the RECOGNITION check asked, separately, whether
   the page reads like a Form No. 16 at all - and that is the one that was
   turning the real form away, with 'This does not look like a Form No. 16'.

   It was not lying about what it saw. The form is photographed rather than
   scanned, and it arrived sideways: OCR follows columns down a page it cannot
   orient, so 'FORM NO 16' and 'CERTIFICATE UNDER SECTION 203' were never in the
   text to be matched. Reading a rotated page properly was tried in
   documentText.service and does not work; the comment there records why.

   So the recognition keywords go. The name check STAYS, and on this document it
   is the stronger of the two anyway: a form belonging to somebody else is the
   mistake worth catching, and it catches that whichever way up the page is.
   ============================================================================= */

SET NOCOUNT ON;
GO

UPDATE dbo.DocumentTypes
   SET RecognitionKeywords = NULL, UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode = 'FORM_16';
GO
