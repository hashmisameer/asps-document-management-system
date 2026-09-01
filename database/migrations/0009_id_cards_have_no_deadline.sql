/* =============================================================================
   ASPS-DMS  -  0009  The two ID cards have no deadline
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The Aadhaar Card and the PAN Card must be attached before an employee can be
   created. A deadline of "two days after joining" is therefore meaningless for
   them: either the file was there at the moment the record was made, or the
   record predates the rule. Neither of those is a document running late.

   Leaving the deadline in place made every screen say something untrue. The
   report counted the cards as overdue, the dashboard counted them in its
   overdue total, and the daily reminder chased people for them - all describing
   a lateness that cannot happen.

   Two changes, because one without the other leaves the system disagreeing with
   itself:

     1. The TYPES lose their deadline, so no checklist row created from here on
        gets a due date for them.
     2. The ROWS already written lose their DueDate, so the employees on file
        stop being reported as late for a document that was never late.

   What does NOT change: those documents are still MANDATORY and still counted
   as outstanding when they are missing. An employee on file without an Aadhaar
   card is a real gap and still appears as one - as missing, which is what it
   is, rather than as overdue, which it is not.
   ============================================================================= */

SET NOCOUNT ON;
GO

UPDATE dbo.DocumentTypes
   SET DeadlineValue = NULL,
       DeadlineUnit  = NULL,
       UpdatedAt     = SYSUTCDATETIME()
 WHERE DocumentCode IN ('AADHAAR_CARD', 'PAN_CARD')
   AND (DeadlineValue IS NOT NULL OR DeadlineUnit IS NOT NULL);
GO

UPDATE d
   SET d.DueDate   = NULL,
       d.UpdatedAt = SYSUTCDATETIME()
  FROM dbo.EmployeeDocuments AS d
 INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
 WHERE dt.DocumentCode IN ('AADHAAR_CARD', 'PAN_CARD')
   AND d.DueDate IS NOT NULL;
GO
