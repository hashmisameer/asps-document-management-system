/* =============================================================================
   ASPS-DMS  -  0025  The checklist is decided in code
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   What the checklist asks for - the ten documents, which of them are mandatory,
   and how long people have to bring them - is now
   shared/src/constants/documentChecklist.ts, and the application applies it over
   every row it reads from dbo.DocumentTypes.

   It was a Settings screen, briefly. The office asked for it back in code: the
   list has been the same ten documents for years, and a screen that can change
   what every employee is chased for is a screen somebody changes by accident.

   THE TABLE IS STILL WRITTEN, and this migration is what writes it. Two reasons
   it cannot simply be left to drift:

     - SQL filters on it. The reports offer 'mandatory only', and that predicate
       runs in the database, where the constant is not.
     - A row that disagrees with the application is a trap for whoever reads the
       table next, which is usually somebody with a support question.

   So this states the whole list, exactly as the constant states it. If the two
   are edited apart, the test in backend/tests/unit/documentChecklist.ts fails.
   ============================================================================= */

SET NOCOUNT ON;
GO

/* ---------------------------------------------------------------------------
   Bank Proof - not a document this company collects.

   0024 retired it. Repeated here because a database restored from a backup
   taken before that migration would otherwise carry it back, and because this
   file is where somebody now looks to see what the list is.
   ------------------------------------------------------------------------ */
UPDATE d
   SET d.IsActive  = 0,
       d.UpdatedAt = SYSUTCDATETIME()
  FROM dbo.EmployeeDocuments AS d
 INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
 WHERE d.IsActive = 1
   AND (dt.DocumentCode IN ('BANK_PROOF', 'BANKPROOF', 'BANK')
        OR REPLACE(UPPER(dt.DocumentName), ' ', '') = 'BANKPROOF');
GO

UPDATE dbo.DocumentTypes
   SET IsActive  = 0,
       UpdatedAt = SYSUTCDATETIME()
 WHERE IsActive = 1
   AND (DocumentCode IN ('BANK_PROOF', 'BANKPROOF', 'BANK')
        OR REPLACE(UPPER(DocumentName), ' ', '') = 'BANKPROOF');
GO

/* ---------------------------------------------------------------------------
   The ten, as documentChecklist.ts states them.
   ------------------------------------------------------------------------ */
WITH checklist (DocumentCode, IsMandatory, DeadlineValue, DeadlineUnit) AS (
    SELECT * FROM (VALUES
        ('APPOINTMENT_LETTER',  1, 7,    'DAY'),
        ('BIO_DATA',            1, 7,    'DAY'),
        ('AADHAAR_CARD',        1, NULL, NULL),
        ('PAN_CARD',            1, NULL, NULL),
        ('PF_FORM',             0, NULL, NULL),
        ('ESIC_FORM',           0, NULL, NULL),
        ('SERVICE_CARD',        1, 7,    'DAY'),
        ('GRATUITY_FORM',       1, 7,    'DAY'),
        ('FORM_16',             1, 7,    'DAY'),
        ('CONFIRMATION_LETTER', 1, 6,    'MONTH')
    ) AS v (DocumentCode, IsMandatory, DeadlineValue, DeadlineUnit)
)
UPDATE dt
   SET dt.IsMandatory   = c.IsMandatory,
       dt.DeadlineValue = c.DeadlineValue,
       dt.DeadlineUnit  = c.DeadlineUnit,
       dt.UpdatedAt     = SYSUTCDATETIME()
  FROM dbo.DocumentTypes AS dt
 INNER JOIN checklist AS c ON c.DocumentCode = dt.DocumentCode
 WHERE dt.IsMandatory   <> c.IsMandatory
    OR ISNULL(dt.DeadlineValue, -1) <> ISNULL(c.DeadlineValue, -1)
    OR ISNULL(dt.DeadlineUnit, '')  <> ISNULL(c.DeadlineUnit, '');
GO

/* The dates already written onto employees' rows for the four that no longer
   have a deadline.

   ONLY where nothing has been attached yet. A card that has already arrived
   keeps the date that applied to it - that is a record of what was asked at the
   time, and a settings change does not rewrite history. */
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
