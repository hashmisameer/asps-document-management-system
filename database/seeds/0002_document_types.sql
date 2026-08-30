/* =============================================================================
   Seed 0002 - Document types

   +-------------------------------------------------------------------------+
   |  INCOMPLETE - AWAITING THE OFFICIAL COMPANY DOCUMENT LIST (item B2).     |
   |                                                                         |
   |  Only PAN CARD is seeded, because it is the single document type        |
   |  confirmed so far:  PAN CARD = MANDATORY.                               |
   |                                                                         |
   |  When the official list arrives, add one row per document below and set  |
   |  IsMandatory = 1 for every document marked "M" on that list, and 0 for   |
   |  every other document. Do NOT guess: an optional document wrongly marked |
   |  mandatory puts a false "Pending" on every employee record, and a        |
   |  mandatory one wrongly marked optional hides a real compliance gap.      |
   +-------------------------------------------------------------------------+

   Idempotent: matches on DocumentCode, so re-running will not duplicate rows
   and will not silently overwrite a value HR has since changed in Settings.

   DeadlineValue / DeadlineUnit are the DEFAULT deadline applied to new joiners
   for this document type. NULL means the document has no submission deadline.
   ============================================================================= */

SET NOCOUNT ON;
GO

MERGE dbo.DocumentTypes AS target
USING (VALUES
    -- DocumentCode, DocumentName,  IsMandatory, RequiresSignature, DeadlineValue, DeadlineUnit, SortOrder
    ('PAN_CARD',  N'PAN Card',      1,           0,                 10,            'DAY',        10)
) AS source (DocumentCode, DocumentName, IsMandatory, RequiresSignature, DeadlineValue, DeadlineUnit, SortOrder)
    ON target.DocumentCode = source.DocumentCode
WHEN NOT MATCHED BY TARGET THEN
    INSERT (DocumentCode, DocumentName, IsMandatory, RequiresSignature, DeadlineValue, DeadlineUnit, SortOrder, IsActive)
    VALUES (source.DocumentCode, source.DocumentName, source.IsMandatory, source.RequiresSignature,
            source.DeadlineValue, source.DeadlineUnit, source.SortOrder, 1);
GO
