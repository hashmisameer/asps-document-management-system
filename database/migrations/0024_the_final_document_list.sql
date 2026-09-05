/* =============================================================================
   ASPS-DMS  -  0024  The document list the office actually keeps
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The list was settled on 2026-09-05. Ten documents, and this is all of them:

     Appointment Letter    mandatory   7 days
     Bio Data Form         mandatory   7 days
     Aadhaar Card          mandatory   no deadline
     PAN Card              mandatory   no deadline
     PF Form               optional    no deadline
     ESIC Form             optional    no deadline
     Service Card          mandatory   7 days
     Payment of Gratuity   mandatory   7 days
     Form No. 16           mandatory   7 days
     Confirmation Letter   mandatory   6 months

   THREE THINGS CHANGE, and one of them reverses a decision made two days ago.

   1. BANK PROOF GOES. It was never on the company's list and was added to this
      database by hand. It is deactivated rather than deleted: a document type
      row is pointed at by every checklist row ever created against it, and
      deleting it would orphan any file somebody has already uploaded and break
      the audit trail that says who uploaded it. The checklist rows themselves
      are deactivated the same way and for the same reason - nothing is removed,
      it simply stops being counted, chased or shown.

   2. SIX DOCUMENTS BECOME MANDATORY. Only the two identity cards were, which
      meant eight of the ten were collected without ever being required. The two
      statutory forms - PF and ESIC - stay optional, because they are filed with
      the government rather than collected from the employee.

   3. THE IDENTITY CARDS LOSE THEIR DEADLINE, which 0022 gave them and 0023
      backfilled onto every existing row. That was done on 2026-09-03 at the
      office's request, on the reasoning that a document that can never be late
      is not tracked, it is listed. The office has now decided the other way:
      the cards and the two statutory forms are chased by hand, not by date.

      Their outstanding rows have their due date cleared here. Without that,
      every employee would keep the date 0023 wrote and go on reading 'Overdue'
      against a deadline the type no longer has.

      Rows that already have a file keep their date. It is a record of what
      applied when the document came in, and rewriting history is not what a
      settings change does.
   ============================================================================= */

SET NOCOUNT ON;
GO

/* ---------------------------------------------------------------------------
   1. Bank Proof
   ------------------------------------------------------------------------ */

/* Matched on the spellings it could have been entered under. It was typed by
   hand, so nothing here can assume a code. */
IF EXISTS (SELECT 1 FROM dbo.DocumentTypes
            WHERE DocumentCode IN ('BANK_PROOF', 'BANKPROOF', 'BANK')
               OR REPLACE(UPPER(DocumentName), ' ', '') = 'BANKPROOF')
BEGIN
    /* The checklist rows first. They are what the screens read; leaving them
       active would keep Bank Proof on every employee's list with its type
       retired underneath it. */
    UPDATE d
       SET d.IsActive  = 0,
           d.UpdatedAt = SYSUTCDATETIME()
      FROM dbo.EmployeeDocuments AS d
     INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
     WHERE d.IsActive = 1
       AND (dt.DocumentCode IN ('BANK_PROOF', 'BANKPROOF', 'BANK')
            OR REPLACE(UPPER(dt.DocumentName), ' ', '') = 'BANKPROOF');

    UPDATE dbo.DocumentTypes
       SET IsActive  = 0,
           UpdatedAt = SYSUTCDATETIME()
     WHERE IsActive = 1
       AND (DocumentCode IN ('BANK_PROOF', 'BANKPROOF', 'BANK')
            OR REPLACE(UPPER(DocumentName), ' ', '') = 'BANKPROOF');
END
GO

/* ---------------------------------------------------------------------------
   2. Which documents must be collected
   ------------------------------------------------------------------------ */

UPDATE dbo.DocumentTypes
   SET IsMandatory = 1, UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode IN ('APPOINTMENT_LETTER', 'BIO_DATA', 'AADHAAR_CARD', 'PAN_CARD',
                        'SERVICE_CARD', 'GRATUITY_FORM', 'FORM_16', 'CONFIRMATION_LETTER')
   AND IsMandatory = 0;
GO

/* Filed with the government rather than collected from the employee. Written
   explicitly rather than left alone, so this migration states the whole rule
   and does not depend on what the row happened to say. */
UPDATE dbo.DocumentTypes
   SET IsMandatory = 0, UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode IN ('PF_FORM', 'ESIC_FORM')
   AND IsMandatory = 1;
GO

/* ---------------------------------------------------------------------------
   3. The deadlines
   ------------------------------------------------------------------------ */

UPDATE dbo.DocumentTypes
   SET DeadlineValue = 7, DeadlineUnit = 'DAY', UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode IN ('APPOINTMENT_LETTER', 'BIO_DATA', 'SERVICE_CARD',
                        'GRATUITY_FORM', 'FORM_16');
GO

/* Six calendar months, not 180 days. Somebody who joined on 31 August is due on
   28 February - the application clamps a short month rather than rolling into
   March. */
UPDATE dbo.DocumentTypes
   SET DeadlineValue = 6, DeadlineUnit = 'MONTH', UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode = 'CONFIRMATION_LETTER';
GO

UPDATE dbo.DocumentTypes
   SET DeadlineValue = NULL, DeadlineUnit = NULL, UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode IN ('AADHAAR_CARD', 'PAN_CARD', 'PF_FORM', 'ESIC_FORM');
GO

/* The dates already written onto employees' rows for those four.

   ONLY where nothing has been attached yet, exactly as 0023 only wrote dates
   onto rows with nothing attached. A card that has already arrived keeps the
   date that applied to it. */
UPDATE d
   SET d.DueDate   = NULL,
       d.UpdatedAt = SYSUTCDATETIME()
  FROM dbo.EmployeeDocuments AS d
 INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
 WHERE d.IsActive = 1
   AND d.OriginalFilePath IS NULL
   AND d.DueDate IS NOT NULL
   AND dt.DocumentCode IN ('AADHAAR_CARD', 'PAN_CARD', 'PF_FORM', 'ESIC_FORM');
GO
