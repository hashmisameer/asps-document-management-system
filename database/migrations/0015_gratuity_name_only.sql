/* =============================================================================
   ASPS-DMS  -  0015  Payment of Gratuity is checked for the name, and nothing else
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The office asked, on 2026-09-02, that this document be checked only on
   whether the employee's name matches.

   Two checks ran on it. The field check looks for the name - that one is
   wanted, and stays. The RECOGNITION check asked separately whether the page
   reads like a gratuity form, by looking for 'PAYMENT OF GRATUITY', 'FORM F'
   and the rest; that one is removed here.

   It was the check with the least to offer on this particular document. Put
   through OCR the office's own gratuity form returned ZERO characters, so the
   recognition test could never see its heading - and on a partial reading, where
   a photocopied form gives up half its words, it is exactly the test that turns
   a correct document away for a phrase that did not survive the scan.

   The name check is the stronger of the two here and does the job the office
   actually cares about: that this form belongs to the employee it is filed
   under. Same decision, and the same reasoning, as Form No. 16 in 0014.
   ============================================================================= */

SET NOCOUNT ON;
GO

UPDATE dbo.DocumentTypes
   SET RecognitionKeywords = NULL, UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode = 'GRATUITY_FORM';
GO
