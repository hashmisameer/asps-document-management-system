/* =============================================================================
   ASPS-DMS  -  0022  'Mandatory' and 'needed before the record exists' are two things
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The office drew this distinction on 2026-09-03, and the application had been
   conflating the two:

     MANDATORY           the document must be collected. It appears on the
                         checklist, it goes pending, it goes overdue, and it is
                         counted in the reports until it arrives.

     REQUIRED AT CREATION  it must be in hand before the employee record can be
                         created at all.

   IsMandatory carried both meanings, so the Add Employee form read it and
   refused to create anybody without an Aadhaar and a PAN in the room. That is
   not the rule. The rule is that those two documents must be collected - which
   is a thing the checklist chases, not a thing that blocks a record being made.

   IsMandatory is UNCHANGED for both cards. They stay mandatory, they stay
   tracked, they still go overdue. Only the second meaning is being taken away,
   and it is being taken away from every document type: nothing is required
   before the record exists any more.

   THE TWO CARDS ALSO GAIN A DEADLINE. 0009 took theirs off, on the reasoning
   that a document required before the record existed could not also be late.
   Now that they are collected like everything else, they need a date to be late
   against - without one they would sit 'Pending' for ever and appear in no
   overdue report, which is the quiet version of not tracking them at all.

   SEVEN DAYS, as an interim. The office was asked and has not said yet; seven
   matches the service card and the appointment letter, which are the documents
   collected alongside these. Change the value here when they decide.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF COL_LENGTH(N'dbo.DocumentTypes', N'RequiredAtCreation') IS NULL
BEGIN
    ALTER TABLE dbo.DocumentTypes
        ADD RequiredAtCreation BIT NOT NULL
            CONSTRAINT DF_DocTypes_RequiredAtCreation DEFAULT (0);
END
GO

/* Explicit rather than relying on the default, so the intent is readable here
   rather than inferred from a column definition. */
UPDATE dbo.DocumentTypes
   SET RequiredAtCreation = 0, UpdatedAt = SYSUTCDATETIME();
GO

UPDATE dbo.DocumentTypes
   SET DeadlineValue = 7, DeadlineUnit = 'DAY', UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode IN ('AADHAAR_CARD', 'PAN_CARD');
GO
