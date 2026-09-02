/* =============================================================================
   ASPS-DMS  -  0011  Recognising the Hindi forms, and Employee's State Insurance
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   Two corrections to the recognition phrases, both from looking at the real
   documents rather than at what they are called.

   1. THE APPOINTMENT LETTER IS PRINTED IN HINDI. 'APPOINTMENT LETTER' appears
      nowhere on it, so the type could never be recognised - and until OCR was
      told to read Devanagari it returned nothing usable from the page at all.
      The Hindi headings are added here; OCR_LANGUAGES now defaults to eng+hin.

      The English phrases stay. An office of this size will have both, and a
      letter that carries either is the same document.

   2. ESIC is EMPLOYEE'S STATE INSURANCE CORPORATION, with an apostrophe. The
      full name is added, and the matcher now drops apostrophes rather than
      treating them as word breaks, so 'EMPLOYEE'S' and 'EMPLOYEES' are one word.

   Written as an UPDATE of the whole list rather than an append, so the phrases
   for these types are stated in one place instead of being assembled by reading
   two migrations together.
   ============================================================================= */

SET NOCOUNT ON;
GO

/* नियुक्ति पत्र - appointment letter. सेवा नियुक्ति - engagement of service. */
UPDATE dbo.DocumentTypes
   SET RecognitionKeywords = N'APPOINTMENT LETTER,LETTER OF APPOINTMENT,APPOINTMENT,नियुक्ति पत्र,नियुक्ति,नियुक्तिपत्र,सेवा नियुक्ति'
 WHERE DocumentCode = 'APPOINTMENT_LETTER';

UPDATE dbo.DocumentTypes
   SET RecognitionKeywords = N'EMPLOYEES STATE INSURANCE CORPORATION,EMPLOYEES STATE INSURANCE,STATE INSURANCE,ESIC,ESI CORPORATION,कर्मचारी राज्य बीमा'
 WHERE DocumentCode = 'ESIC_FORM';

/* The others gain their Hindi headings too, where the form has one. A document
   is the same document in either language, and the office prints both. */
UPDATE dbo.DocumentTypes
   SET RecognitionKeywords = N'BIO DATA,BIODATA,BIO DATA FORM,APPLICATION FOR EMPLOYMENT,बायो डाटा,आवेदन पत्र'
 WHERE DocumentCode = 'BIO_DATA';

UPDATE dbo.DocumentTypes
   SET RecognitionKeywords = N'AADHAAR,AADHAR,ADHAAR,UNIQUE IDENTIFICATION AUTHORITY,UIDAI,MERA AADHAAR MERI PEHCHAN,आधार,भारतीय विशिष्ट पहचान'
 WHERE DocumentCode = 'AADHAAR_CARD';

UPDATE dbo.DocumentTypes
   SET RecognitionKeywords = N'INCOME TAX DEPARTMENT,PERMANENT ACCOUNT NUMBER,PERMANENT ACCOUNT NO,आयकर विभाग,स्थायी लेखा संख्या'
 WHERE DocumentCode = 'PAN_CARD';

UPDATE dbo.DocumentTypes
   SET RecognitionKeywords = N'PROVIDENT FUND,EMPLOYEES PROVIDENT FUND,EPF,FORM 11,NOMINATION AND DECLARATION,भविष्य निधि,कर्मचारी भविष्य निधि'
 WHERE DocumentCode = 'PF_FORM';

UPDATE dbo.DocumentTypes
   SET RecognitionKeywords = N'SERVICE CARD,SERVICE CAR,FORM V,सेवा कार्ड'
 WHERE DocumentCode = 'SERVICE_CARD';

UPDATE dbo.DocumentTypes
   SET RecognitionKeywords = N'GRATUITY,FORM F,NOMINATION,उपदान,ग्रेच्युटी'
 WHERE DocumentCode = 'GRATUITY_FORM';

UPDATE dbo.DocumentTypes
   SET RecognitionKeywords = N'FORM NO 16,FORM 16,CERTIFICATE UNDER SECTION 203,TDS,फॉर्म 16'
 WHERE DocumentCode = 'FORM_16';

UPDATE dbo.DocumentTypes
   SET RecognitionKeywords = N'CONFIRMATION LETTER,LETTER OF CONFIRMATION,CONFIRMATION OF EMPLOYMENT,पुष्टि पत्र,स्थायीकरण'
 WHERE DocumentCode = 'CONFIRMATION_LETTER';
GO
