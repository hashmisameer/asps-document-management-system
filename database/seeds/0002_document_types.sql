/* =============================================================================
   Seed 0002 - Document types

   The official company list (open question B2), as supplied on 2026-08-31 and
   CONFIRMED on 2026-08-31:

       1  Appointment letter                 7 days
       2  Bio Data form                      7 days
       3  Aadhaar Card            MANDATORY  2 days
       4  PAN Card                MANDATORY  2 days
       5  PF form                            10 days
       6  ESIC form                          10 days
       7  Service Card                       7 days
       8  Payment of Gratuity                7 days
       9  Form No. 16                        7 days
      10  Confirmation letter                6 months from date of joining

   ONLY the Aadhaar Card and the PAN Card are mandatory. Every other document is
   OPTIONAL, and the marks on the original sheet - the struck-through ones, the
   circled (E), the unmarked Service Card - do not make any of them required.
   That was confirmed directly, which settles what the sheet could not.

   Optional does NOT mean undated. Every type keeps its own deadline, so each
   one still appears on the checklist with a date to chase, and 'Overdue' still
   means overdue. What being optional changes is that a missing one is not a
   compliance failure against the employee record - the two ID cards are.

   RequiredFields is the identity check: which of the employee's own details the
   document must confirm before it can be uploaded, compared against the values
   typed when the employee was created. A document whose text names a different
   person, or a different employee code, is refused.

   As specified by the office on 2026-09-02: name, code and joining date on the
   four forms that carry all three, and the name alone on the rest.

   THE TWO ID CARDS ARE NOT TEXT-CHECKED. A photograph of a laminated PAN card
   put through this system's OCR came back as 2,173 characters of noise - not a
   wrong document, an unread one - and the check refused it every time. They are
   attached before an employee can be created, by a person holding the card, and
   that is the verification for these two. NULL means "not checked", which is a
   different answer from "checked against nothing".

   ASSUMPTION - RequiresSignature is 1 for the company's own forms and 0 for the
   Aadhaar and PAN cards, which are the employee's identity documents rather
   than something they sign here. Say so if any of them is wrong; it is one
   value per row.

   Idempotent: matches on DocumentCode, so re-running will not duplicate rows
   and will not silently overwrite a value HR has since changed in Settings.

   The two ID cards have NO deadline. They must be attached before an employee
   can be created, so either the file was there when the record was made or the
   record predates that rule - neither is a document running late. They are
   still mandatory, and still counted as outstanding when missing.

   DeadlineValue / DeadlineUnit are the DEFAULT deadline applied to new joiners
   for this document type. NULL means the document has no submission deadline.
   ============================================================================= */

SET NOCOUNT ON;
GO

MERGE dbo.DocumentTypes AS target
USING (VALUES
    -- DocumentCode, DocumentName, IsMandatory, RequiresSignature, DeadlineValue, DeadlineUnit, SortOrder, RequiredFields
    ('APPOINTMENT_LETTER', N'Appointment Letter', 1, 1,  7, 'DAY',    10,
     N'EmployeeName,EmployeeCode,JoiningDate'),

    ('BIO_DATA',           N'Bio Data Form',      1, 1,  7, 'DAY',    20,
     N'EmployeeName,EmployeeCode,JoiningDate'),

    -- The two identity cards and the two statutory forms carry NO deadline.
    -- They are collected and chased by hand rather than by date: 0022 gave the
    -- cards seven days, and the office decided against it on 2026-09-05.
    ('AADHAAR_CARD',       N'Aadhaar Card',       1, 0,  NULL, NULL,   30,
     N'EmployeeName'),

    ('PAN_CARD',           N'PAN Card',           1, 0,  NULL, NULL,   40,
     N'EmployeeName'),

    -- Optional: filed with the government, not collected from the employee.
    ('PF_FORM',            N'PF Form',            0, 1, NULL, NULL,   50,
     N'EmployeeName'),

    ('ESIC_FORM',          N'ESIC Form',          0, 1, NULL, NULL,   60,
     N'EmployeeName'),

    ('SERVICE_CARD',       N'Service Card',       1, 1,  7, 'DAY',    70,
     N'EmployeeName,EmployeeCode,JoiningDate'),

    ('GRATUITY_FORM',      N'Payment of Gratuity',   1, 1,  7, 'DAY',    80,
     N'EmployeeName'),

    ('FORM_16',            N'Form No. 16',        1, 1,  7, 'DAY',    90,
     N'EmployeeName'),

    -- Six months from joining, not days: confirmation follows the probation
    -- period. A short target month is clamped - 31 August is due 28 February.
    ('CONFIRMATION_LETTER', N'Confirmation Letter', 1, 1, 6, 'MONTH', 100,
     N'EmployeeName,EmployeeCode,JoiningDate')
) AS source (DocumentCode, DocumentName, IsMandatory, RequiresSignature,
             DeadlineValue, DeadlineUnit, SortOrder, RequiredFields)
    ON target.DocumentCode = source.DocumentCode
WHEN NOT MATCHED BY TARGET THEN
    INSERT (DocumentCode, DocumentName, IsMandatory, RequiresSignature, DeadlineValue,
            DeadlineUnit, SortOrder, RequiredFields, IsActive)
    VALUES (source.DocumentCode, source.DocumentName, source.IsMandatory, source.RequiresSignature,
            source.DeadlineValue, source.DeadlineUnit, source.SortOrder, source.RequiredFields, 1);
GO
