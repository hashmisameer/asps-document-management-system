/* =============================================================================
   ASPS-DMS  -  0038  'NotInList': a type the server is not set to stamp
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   MMC prints the employee's signature and the HR stamp on every form it
   generates except the ESIC form, so stamping on upload is now confined to
   a list of document types - AUTO_STAMP_TYPES in the backend's environment.
   A document of any other type is still decided about, and the decision is
   recorded like every other: 'NotInList', with the stamped count at zero.
   It is not a failure and the report does not count it as one; it says the
   type was left for HR on purpose, and why.

   The outcome constraint names its values, so widening it is drop-and-
   recreate, done only when 'NotInList' is not yet among them so the
   migration can be run again without effect. Every existing row satisfies
   the wider rule.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints
            WHERE name = N'CK_StampDec_Outcome'
              AND definition NOT LIKE N'%NotInList%')
BEGIN
    ALTER TABLE dbo.StampDecisions DROP CONSTRAINT CK_StampDec_Outcome;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_StampDec_Outcome')
BEGIN
    ALTER TABLE dbo.StampDecisions
        ADD CONSTRAINT CK_StampDec_Outcome
            CHECK (Outcome IN (
                'Stamped', 'Partial', 'Nothing',
                'NoTemplate', 'NoVariant', 'AmbiguousVariant', 'NotPdf', 'Unreadable',
                'IdentityFailed', 'Failed', 'NotInList'
            ));
END
GO
