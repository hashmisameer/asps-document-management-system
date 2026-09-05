/* =============================================================================
   ASPS-DMS  -  0013  The gratuity form, under the name it is actually printed
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The office calls this document 'Payment of Gratuity', and so does the
   document: it is Form F under the Payment of Gratuity Act, 1972. 'Form of
   Gratuity' was this system's own invention and appears on no piece of paper
   anybody in the office is holding.

   Two things follow from that, and only the second one changes any behaviour.

   1. The checklist now says what the person filing it says.

   2. 'PAYMENT OF GRATUITY' and the Act join the recognition phrases. The list
      already carried the bare word GRATUITY, which does match the heading, so
      this is not a fix for a document being refused - the gratuity form's
      failure was an upload timeout, since corrected. It is added because the
      form's full printed title should be in the list on its own account, and
      because 'FORM F' alone is two letters away from matching half the forms
      in the drawer.
   ============================================================================= */

SET NOCOUNT ON;
GO

UPDATE dbo.DocumentTypes
   SET DocumentName = N'Payment of Gratuity',
       RecognitionKeywords = N'PAYMENT OF GRATUITY,GRATUITY,PAYMENT OF GRATUITY ACT,FORM F,NOMINATION,उपदान,ग्रेच्युटी,उपदान का भुगतान',
       UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode = 'GRATUITY_FORM';
GO
