/* =============================================================================
   ASPS-DMS  -  0010  Recognising WHICH document was uploaded
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The identity check answers "is this document about the right person". It has
   never answered "is this the document it is being filed as" - so an Aadhaar
   card uploaded against the PAN Card row passed, because the employee's name
   and code are on both.

   RecognitionKeywords holds the phrases that identify a document as its type: a
   comma-separated list, of which ONE must appear in the text. Several per type
   on purpose, because OCR loses characters - a real service card here was read
   as 'SERVICE CAR', and would have failed on that phrase alone while matching
   'FORM V' from the same page.

   Configuration rather than code, like RequiredFields beside it: which phrases
   identify a document is the kind of thing that gets corrected after seeing a
   real one, and that should not need a deployment.

   NULL means "do not check", which is a different answer from "checked and
   matched nothing", and is how a document type with no reliable wording opts
   out.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF COL_LENGTH(N'dbo.DocumentTypes', N'RecognitionKeywords') IS NULL
BEGIN
    ALTER TABLE dbo.DocumentTypes ADD RecognitionKeywords NVARCHAR(600) NULL;
END
GO

/* Seeded here as well as in seed 0002, so a database that already exists gains
   the keywords without waiting for a re-seed - and the seed only ever INSERTS,
   so it would never have added them to these rows. */
UPDATE dbo.DocumentTypes SET RecognitionKeywords = N'APPOINTMENT LETTER,LETTER OF APPOINTMENT,APPOINTMENT'
 WHERE DocumentCode = 'APPOINTMENT_LETTER' AND RecognitionKeywords IS NULL;

UPDATE dbo.DocumentTypes SET RecognitionKeywords = N'BIO DATA,BIODATA,BIO DATA FORM,APPLICATION FOR EMPLOYMENT'
 WHERE DocumentCode = 'BIO_DATA' AND RecognitionKeywords IS NULL;

/* AADHAR and ADHAAR are the spellings OCR and data entry actually produce. */
UPDATE dbo.DocumentTypes SET RecognitionKeywords = N'AADHAAR,AADHAR,ADHAAR,UNIQUE IDENTIFICATION AUTHORITY,UIDAI,MERA AADHAAR MERI PEHCHAN'
 WHERE DocumentCode = 'AADHAAR_CARD' AND RecognitionKeywords IS NULL;

UPDATE dbo.DocumentTypes SET RecognitionKeywords = N'INCOME TAX DEPARTMENT,PERMANENT ACCOUNT NUMBER,PERMANENT ACCOUNT NO'
 WHERE DocumentCode = 'PAN_CARD' AND RecognitionKeywords IS NULL;

UPDATE dbo.DocumentTypes SET RecognitionKeywords = N'PROVIDENT FUND,EMPLOYEES PROVIDENT FUND,EPF,FORM 11,NOMINATION AND DECLARATION'
 WHERE DocumentCode = 'PF_FORM' AND RecognitionKeywords IS NULL;

UPDATE dbo.DocumentTypes SET RecognitionKeywords = N'EMPLOYEES STATE INSURANCE,STATE INSURANCE,ESIC,ESI CORPORATION,DECLARATION FORM'
 WHERE DocumentCode = 'ESIC_FORM' AND RecognitionKeywords IS NULL;

/* FORM V because a scan of the real card lost the D from 'SERVICE CARD'. */
UPDATE dbo.DocumentTypes SET RecognitionKeywords = N'SERVICE CARD,SERVICE CAR,FORM V'
 WHERE DocumentCode = 'SERVICE_CARD' AND RecognitionKeywords IS NULL;

UPDATE dbo.DocumentTypes SET RecognitionKeywords = N'GRATUITY,FORM F,NOMINATION'
 WHERE DocumentCode = 'GRATUITY_FORM' AND RecognitionKeywords IS NULL;

UPDATE dbo.DocumentTypes SET RecognitionKeywords = N'FORM NO 16,FORM 16,CERTIFICATE UNDER SECTION 203,TDS'
 WHERE DocumentCode = 'FORM_16' AND RecognitionKeywords IS NULL;

UPDATE dbo.DocumentTypes SET RecognitionKeywords = N'CONFIRMATION LETTER,LETTER OF CONFIRMATION,CONFIRMATION OF EMPLOYMENT'
 WHERE DocumentCode = 'CONFIRMATION_LETTER' AND RecognitionKeywords IS NULL;
GO
