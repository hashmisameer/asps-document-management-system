/* =============================================================================
   ASPS-DMS  -  0037  Every automatic stamping decision is recorded
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   A document is uploaded; if its type has a template and the file matches
   one of the template's variants, the signatures are stamped there and then,
   with no screen and no approval. The employee's signature is the one on
   their record, which comes from MMC's own folder; the authoriser's is the
   uploader's; the photograph is the employee's. A box is left alone - not
   refused, not asked about, simply not guessed at - when something is
   already in it, when the image it needs does not exist, or when the file
   matches no template.

   THIS TABLE IS WHAT MAKES THAT SAFE TO SWITCH ON. Every decision is a row:
   which document, which mode the server was in, what was decided for every
   box and why, in the words HR reads. In REPORT mode the application decides
   and records and stamps nothing, so the office can watch what it WOULD have
   done for a few days on real uploads before AUTO_STAMP is set to stamp.
   After that, the same rows answer 'why does this document have no
   authoriser signature' without anyone reading a log file.

   One row per decision, never updated: a document uploaded twice has two
   rows, and the latest is the one that stands. BoxesJson holds the box-level
   detail - role, page, verdict, reason - as a document rather than a child
   table, because it is read as a whole and never queried by box.

   'Template' joins the detection methods on SignaturePlacements: a box the
   application placed from the type's template says so, next to the ones a
   person drew and the ones detection proposed.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF OBJECT_ID(N'dbo.StampDecisions', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.StampDecisions
    (
        StampDecisionId  INT            NOT NULL IDENTITY(1,1),
        DocumentId       INT            NOT NULL,
        /* What the server was set to: decided and recorded only, or stamped. */
        Mode             VARCHAR(10)    NOT NULL,
        /* The decision for the document as a whole. */
        Outcome          VARCHAR(20)    NOT NULL,
        /* '2p-595x842': the template variant the file matched, when one did. */
        VariantKey       VARCHAR(40)    NULL,
        /* Boxes the decision said to stamp, and boxes it left alone. In report
           mode the first is what WOULD have been stamped. */
        StampedCount     INT            NOT NULL CONSTRAINT DF_StampDec_Stamped DEFAULT (0),
        SkippedCount     INT            NOT NULL CONSTRAINT DF_StampDec_Skipped DEFAULT (0),
        /* One sentence, written for HR: what happened and why. */
        Summary          NVARCHAR(500)  NOT NULL,
        /* Every box: role, page, what was found in it, what was decided, why. */
        BoxesJson        NVARCHAR(MAX)  NOT NULL,
        /* Whose upload it was - the authoriser box is theirs. */
        DecidedBy        INT            NULL,
        DecidedAt        DATETIME2(3)   NOT NULL CONSTRAINT DF_StampDec_DecidedAt DEFAULT (SYSUTCDATETIME()),

        CONSTRAINT PK_StampDecisions PRIMARY KEY CLUSTERED (StampDecisionId),
        CONSTRAINT FK_StampDec_Documents FOREIGN KEY (DocumentId) REFERENCES dbo.EmployeeDocuments (DocumentId),
        CONSTRAINT FK_StampDec_DecidedBy FOREIGN KEY (DecidedBy) REFERENCES dbo.Users (UserId),
        CONSTRAINT CK_StampDec_Mode CHECK (Mode IN ('Report', 'Stamp')),
        CONSTRAINT CK_StampDec_Outcome CHECK (Outcome IN (
            'Stamped', 'Partial', 'Nothing',
            'NoTemplate', 'NoVariant', 'AmbiguousVariant', 'NotPdf', 'Unreadable',
            'IdentityFailed', 'Failed'
        )),
        CONSTRAINT CK_StampDec_Counts CHECK (StampedCount >= 0 AND SkippedCount >= 0)
    );

    /* The latest decision for a document is what the checklist shows. */
    CREATE NONCLUSTERED INDEX IX_StampDec_Document ON dbo.StampDecisions (DocumentId, DecidedAt DESC);
END
GO

/* ---------------------------------------------------------------------------
   'Template' as a detection method.

   The constraint names its values, so widening it is drop-and-recreate; done
   only when 'Template' is not yet among them, so the migration can be run
   again without effect. The existing rows all satisfy the wider rule.
   ------------------------------------------------------------------------ */
IF EXISTS (SELECT 1 FROM sys.check_constraints
            WHERE name = N'CK_SigPlace_DetectionMethod'
              AND definition NOT LIKE N'%Template%')
BEGIN
    ALTER TABLE dbo.SignaturePlacements DROP CONSTRAINT CK_SigPlace_DetectionMethod;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_SigPlace_DetectionMethod')
BEGIN
    ALTER TABLE dbo.SignaturePlacements
        ADD CONSTRAINT CK_SigPlace_DetectionMethod
            CHECK (DetectionMethod IN ('OCR', 'CV', 'Combined', 'Manual', 'Template'));
END
GO
