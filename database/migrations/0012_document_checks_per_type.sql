/* =============================================================================
   ASPS-DMS  -  0012  What each document is actually checked for
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The details each document must confirm, as the office specified them on
   2026-09-02. Everything is compared against the employee record - the values
   typed when the employee was created - so the check asks whether the document
   in front of somebody belongs to the person it is being filed under.

     Bio Data Form        name, employee code, joining date
     Service Card         name, employee code, joining date
     Appointment Letter   name, employee code, joining date
     Confirmation Letter  name, employee code, joining date
     PF Form              name
     ESIC Form            name
     Form of Gratuity     name
     Form No. 16          name
     Aadhaar Card         nothing - see below
     PAN Card             nothing - see below

   Several types were asking for MORE than this and refusing genuine documents
   for it: the service card wanted nine fields including UAN and ESI numbers,
   the bio data form wanted the post applied for and a phone number, and the
   confirmation letter wanted the appointment letter's date. A check nobody
   asked for that turns away a correct document is worse than no check.

   THE TWO ID CARDS ARE NO LONGER TEXT-CHECKED AT ALL, and their recognition
   keywords go with the field list.

   This is not a preference. A photograph of a laminated PAN card was put
   through this system's own OCR and came back as 2,173 characters of noise -
   no readable phrase, nothing of the number, nothing of 'INCOME TAX
   DEPARTMENT'. The recognition check then refused it as the wrong KIND of
   document, which it was not; it was simply never read. A legibility test was
   tried to tell that case apart and does not work: the noise scored 213 words
   of three letters or more, where a service card that read perfectly scored
   106.

   So the check was refusing correct cards and could only be cleared by an
   override, every time, for the two documents that must be attached before an
   employee can be created at all. The person attaching them is holding the
   card. That is the verification for these two.

   Everything else keeps its recognition keywords: those are printed forms, and
   they read.
   ============================================================================= */

SET NOCOUNT ON;
GO

UPDATE dbo.DocumentTypes
   SET RequiredFields = N'EmployeeName,EmployeeCode,JoiningDate', UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode IN ('BIO_DATA', 'SERVICE_CARD', 'APPOINTMENT_LETTER', 'CONFIRMATION_LETTER');
GO

UPDATE dbo.DocumentTypes
   SET RequiredFields = N'EmployeeName', UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode IN ('PF_FORM', 'ESIC_FORM', 'GRATUITY_FORM', 'FORM_16');
GO

UPDATE dbo.DocumentTypes
   SET RequiredFields = NULL, RecognitionKeywords = NULL, UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode IN ('AADHAAR_CARD', 'PAN_CARD');
GO
