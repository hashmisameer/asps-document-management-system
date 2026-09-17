/* =============================================================================
   ASPS-DMS  -  0036  A document type may have more than one form, and a template each
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   'PF Form / Form 11' is one document type on the checklist and two pieces of
   paper: the PF form, two pages, for an employee whose PF is deducted; and
   Form 11, one page, for one whose PF is not. Different layouts, and the
   boxes go in different places. 0035 gave a type ONE template drawn on ONE
   sample, and drawing on the two-page form then switching the sample to the
   one-page form produced a template with a box on page two and a sample of
   one page - refused, correctly, and no way to do it right.

   A type now holds one template PER VARIANT, and a variant is what the PDF
   is: its page count, and its first page's size in whole points. Two columns
   record the size; the page count was already there. Saving a template
   replaces the variant with the same key and leaves the others alone. When
   an upload is stamped, the app picks the variant whose page count matches
   exactly and whose page size matches within two points - a PDF re-saved
   through a printer driver can move by a fraction - and stamps nothing when
   none does. It never guesses at the nearest.

   WHAT THIS CANNOT TELL APART: two forms with the same page count AND the
   same page size and different layouts. Saving one over the other is a
   replacement, and the screen says so before it happens; telling them apart
   by what is printed on them is the recognition work that comes later.

   The two columns are backfilled from each row's own page size, so a
   template saved under 0035 becomes a correctly keyed variant with nothing
   lost. The index on the type becomes an index on the variant.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF COL_LENGTH(N'dbo.DocumentTypePlacements', N'SampleWidthPt') IS NULL
BEGIN
    ALTER TABLE dbo.DocumentTypePlacements ADD SampleWidthPt INT NULL;
END
GO

IF COL_LENGTH(N'dbo.DocumentTypePlacements', N'SampleHeightPt') IS NULL
BEGIN
    ALTER TABLE dbo.DocumentTypePlacements ADD SampleHeightPt INT NULL;
END
GO

/* Backfill from the row's own page: under 0035 every box of a template was
   drawn on one sample, so its page size is the sample's. */
UPDATE dbo.DocumentTypePlacements
   SET SampleWidthPt  = ROUND(PageWidthPt, 0),
       SampleHeightPt = ROUND(PageHeightPt, 0)
 WHERE SampleWidthPt IS NULL OR SampleHeightPt IS NULL;
GO

IF EXISTS (SELECT 1 FROM sys.columns
            WHERE object_id = OBJECT_ID(N'dbo.DocumentTypePlacements')
              AND name = N'SampleWidthPt' AND is_nullable = 1)
BEGIN
    ALTER TABLE dbo.DocumentTypePlacements ALTER COLUMN SampleWidthPt INT NOT NULL;
END
GO

IF EXISTS (SELECT 1 FROM sys.columns
            WHERE object_id = OBJECT_ID(N'dbo.DocumentTypePlacements')
              AND name = N'SampleHeightPt' AND is_nullable = 1)
BEGIN
    ALTER TABLE dbo.DocumentTypePlacements ALTER COLUMN SampleHeightPt INT NOT NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_TypePlace_SampleSize')
BEGIN
    ALTER TABLE dbo.DocumentTypePlacements
        ADD CONSTRAINT CK_TypePlace_SampleSize CHECK (SampleWidthPt > 0 AND SampleHeightPt > 0);
END
GO

IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_TypePlace_DocumentType')
BEGIN
    DROP INDEX IX_TypePlace_DocumentType ON dbo.DocumentTypePlacements;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_TypePlace_Variant')
BEGIN
    CREATE INDEX IX_TypePlace_Variant
        ON dbo.DocumentTypePlacements (DocumentTypeId, SamplePageCount, SampleWidthPt, SampleHeightPt);
END
GO
