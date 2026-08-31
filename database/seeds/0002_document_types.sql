/* =============================================================================
   Seed 0002 - Document types

   The official company list (open question B2), as supplied on 2026-08-31:

       1  Appointment letter      M          7 days
       2  Bio Data form           M          7 days
       3  Aadhaar Card            M    (E)   2 days
       4  PAN Card                M    (E)   2 days
       5  PF form                            10 days
       6  ESIC form                    (E)   10 days
       7  Service Card                       7 days
       8  Form of Gratuity        M          7 days
       9  Form No. 16             M          7 days
      10  Confirmation letter                6 months from date of joining

   IsMandatory = 1 for the six marked M, and 0 for the four that are not.
   +-------------------------------------------------------------------------+
   |  STILL TO CONFIRM: the marks against PF form (5) and Confirmation letter |
   |  (10) are struck through rather than a clear M, Service Card (7) carries |
   |  no mark, and the circled (E) on 3, 4 and 6 has not been explained.      |
   |  Those four are seeded OPTIONAL until the marks are confirmed. Wrongly   |
   |  mandatory would put a false 'Pending' on every employee record; wrongly  |
   |  optional hides a real compliance gap. Neither is guessed here - the      |
   |  written mark is followed exactly.                                       |
   +-------------------------------------------------------------------------+

   RequiredFields is the identity check: which of the employee's own details the
   document must confirm before it can be uploaded. A document whose text names
   a different person, or a different employee code, is refused. The two
   identity cards have no field list because none was specified for them, and
   NULL means "not checked" rather than "checked against nothing".

   ASSUMPTION - RequiresSignature is 1 for the company's own forms and 0 for the
   Aadhaar and PAN cards, which are the employee's identity documents rather
   than something they sign here. Say so if any of them is wrong; it is one
   value per row.

   Idempotent: matches on DocumentCode, so re-running will not duplicate rows
   and will not silently overwrite a value HR has since changed in Settings.

   DeadlineValue / DeadlineUnit are the DEFAULT deadline applied to new joiners
   for this document type. NULL means the document has no submission deadline.
   ============================================================================= */

SET NOCOUNT ON;
GO

MERGE dbo.DocumentTypes AS target
USING (VALUES
    -- DocumentCode, DocumentName, IsMandatory, RequiresSignature, DeadlineValue, DeadlineUnit, SortOrder, RequiredFields
    ('APPOINTMENT_LETTER', N'Appointment Letter', 1, 1,  7, 'DAY',    10,
     N'EmployeeName,JoiningDate,EmployeeCode'),

    ('BIO_DATA',           N'Bio Data Form',      1, 1,  7, 'DAY',    20,
     N'PostAppliedFor,EmployeeCode,EmployeeName,Phone,JoiningDate'),

    ('AADHAAR_CARD',       N'Aadhaar Card',       1, 0,  2, 'DAY',    30,
     NULL),

    ('PAN_CARD',           N'PAN Card',           1, 0,  2, 'DAY',    40,
     NULL),

    ('PF_FORM',            N'PF Form',            0, 1, 10, 'DAY',    50,
     N'EmployeeName'),

    ('ESIC_FORM',          N'ESIC Form',          0, 1, 10, 'DAY',    60,
     N'EmployeeName,DateOfBirth,Phone'),

    ('SERVICE_CARD',       N'Service Card',       0, 1,  7, 'DAY',    70,
     N'EmployeeCode,EmployeeName,JoiningDate,Designation,AadhaarNumber,PanNumber,CategoryOfWorkmen,UanNumber,EsiNumber'),

    ('GRATUITY_FORM',      N'Form of Gratuity',   1, 1,  7, 'DAY',    80,
     N'EmployeeName'),

    ('FORM_16',            N'Form No. 16',        1, 1,  7, 'DAY',    90,
     N'EmployeeName'),

    -- Six months from joining, not days: confirmation follows the probation period.
    ('CONFIRMATION_LETTER', N'Confirmation Letter', 0, 1, 6, 'MONTH', 100,
     N'EmployeeName,Phone,AppointmentLetterDate,EmployeeCode')
) AS source (DocumentCode, DocumentName, IsMandatory, RequiresSignature,
             DeadlineValue, DeadlineUnit, SortOrder, RequiredFields)
    ON target.DocumentCode = source.DocumentCode
WHEN NOT MATCHED BY TARGET THEN
    INSERT (DocumentCode, DocumentName, IsMandatory, RequiresSignature, DeadlineValue,
            DeadlineUnit, SortOrder, RequiredFields, IsActive)
    VALUES (source.DocumentCode, source.DocumentName, source.IsMandatory, source.RequiresSignature,
            source.DeadlineValue, source.DeadlineUnit, source.SortOrder, source.RequiredFields, 1);
GO
