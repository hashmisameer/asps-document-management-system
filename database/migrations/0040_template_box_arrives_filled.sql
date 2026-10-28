/* =============================================================================
   ASPS-DMS  -  0040  A template box may be one MMC fills before the upload
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   MMC prints signatures on some of the forms it generates, and not on others.
   On the PF form's two papers it prints:

     Form 11 (1 page)    the employee signature and the HR stamp, page 1
     Form 2  (2 pages)   the HR stamp, page 2 - and NOT the employee signature
                         on page 1 or page 2, which are this system's to stamp

   It prints nothing on the ESIC form.

   Until now a template box could only mean 'stamp this'. A box MMC had already
   filled therefore read as occupied, was left alone, and left the whole
   document waiting for HR - 611 PF forms that need nothing. Nor could the
   occupancy measurement tell the two apart on its own: MMC's genuine Form 11
   signatures and an empty PHOTO placeholder printed inside a box both read 33%.

   So the template says it. ArrivesFilled = 1 on a box means 'MMC fills this
   one; expect it occupied'. This migration adds the column and sets it on the
   three PF boxes above. It changes no stamping decision by itself - the rule
   that reads the flag is a later change.

   THE DEFAULT IS 0 - 'this system fills it', which is what every box meant
   before this file. A box wrongly left at 0 can only send a document to HR to
   look at; a box wrongly set to 1 could let a document be finished unsigned.
   So nothing is 1 unless somebody said so: here, for these three, and from
   now on in the template editor.

   THE ROWS ARE MATCHED by type code, sample page count, role and page - not by
   id, which differs between databases, and not by page size, which the two
   papers do not need to be told apart. Every saved row of those shapes is
   flagged, so an older saved template of the same shape is flagged with the
   newest. Each row flagged is PRINTed, and the count: 3 on a database holding
   today's PF templates, 0 on one with no PF template at all.

   A template saved in the editor replaces its rows, so from now on the editor
   carries this flag through a save; a box drawn fresh starts at 0.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF COL_LENGTH(N'dbo.DocumentTypePlacements', N'ArrivesFilled') IS NULL
BEGIN
    ALTER TABLE dbo.DocumentTypePlacements
        ADD ArrivesFilled BIT NOT NULL
            CONSTRAINT DF_TypePlace_ArrivesFilled DEFAULT (0);
END
GO

DECLARE @flagged TABLE
(
    DocumentTypePlacementId INT          NOT NULL,
    SamplePageCount         INT          NOT NULL,
    SampleWidthPt           INT          NOT NULL,
    SampleHeightPt          INT          NOT NULL,
    SignerRole              VARCHAR(20)  NOT NULL,
    PageNumber              INT          NOT NULL
);

UPDATE tp
   SET tp.ArrivesFilled = 1
OUTPUT inserted.DocumentTypePlacementId, inserted.SamplePageCount,
       inserted.SampleWidthPt, inserted.SampleHeightPt,
       inserted.SignerRole, inserted.PageNumber
  INTO @flagged
  FROM dbo.DocumentTypePlacements AS tp
  JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = tp.DocumentTypeId
 WHERE dt.DocumentCode = 'PF_FORM'
   AND tp.ArrivesFilled = 0
   AND (
        -- Form 11: MMC prints both signatures on its one page.
        (tp.SamplePageCount = 1 AND tp.PageNumber = 1
            AND tp.SignerRole IN ('Employee', 'Authoriser'))
        -- Form 2: MMC prints the HR stamp on page 2, and nothing else.
     OR (tp.SamplePageCount = 2 AND tp.PageNumber = 2
            AND tp.SignerRole = 'Authoriser')
   );

DECLARE @count INT = (SELECT COUNT(*) FROM @flagged);

DECLARE @line NVARCHAR(400);
DECLARE rows_flagged CURSOR LOCAL FAST_FORWARD FOR
    SELECT CONCAT('ArrivesFilled set on DocumentTypePlacementId ', DocumentTypePlacementId,
                  ': PF_FORM ', SamplePageCount, ' page(s) ', SampleWidthPt, 'x', SampleHeightPt,
                  'pt, ', SignerRole, ' box on page ', PageNumber)
    FROM @flagged
    ORDER BY SamplePageCount, PageNumber, SignerRole, DocumentTypePlacementId;
OPEN rows_flagged;
FETCH NEXT FROM rows_flagged INTO @line;
WHILE @@FETCH_STATUS = 0
BEGIN
    PRINT @line;
    FETCH NEXT FROM rows_flagged INTO @line;
END
CLOSE rows_flagged;
DEALLOCATE rows_flagged;

PRINT CONCAT('ArrivesFilled set on ', @count, ' PF_FORM template row(s). ',
             'Expected 3 where today''s PF templates are saved, 0 where there are none.');
GO
