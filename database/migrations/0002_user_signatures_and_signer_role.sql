/* =============================================================================
   ASPS-DMS  -  0002  User signatures, and whose signature a placement carries
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   A document is signed by two people: the EMPLOYEE, and the HR user who
   authorises it. Until now the schema could only express the first - there was
   one signature per employee and a placement said only where it went - so this
   migration adds the second signer and the column that tells them apart.

   Both signatures are enrolled once and reused: the employee signs on the pad
   at enrolment, and each HR user signs once against their own account, so a
   signed document records WHO authorised it rather than an anonymous mark.

   Follows 0001's constraints: no DROP ... IF EXISTS, no JSON, no 2016+ syntax,
   every instant UTC via SYSUTCDATETIME().
   ============================================================================= */

SET NOCOUNT ON;
GO

/* -----------------------------------------------------------------------------
   UserSignatures
   The authorising signature, one per user account rather than per employee.
   Deliberately a separate table from dbo.EmployeeSignatures rather than a
   nullable EmployeeId/UserId pair on one: the two are owned by different
   entities, have different foreign keys, and a single table would need a CHECK
   to stop a row belonging to both or neither.
   -------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.UserSignatures', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.UserSignatures
    (
        UserSignatureId  INT             NOT NULL IDENTITY(1,1),
        UserId           INT             NOT NULL,
        StoredFileName   VARCHAR(100)    NOT NULL,
        FilePath         NVARCHAR(500)   NOT NULL,
        MimeType         VARCHAR(100)    NOT NULL,
        FileSizeBytes    BIGINT          NULL,
        WidthPx          INT             NULL,
        HeightPx         INT             NULL,
        /* Drawn on a signature pad in the browser, or uploaded as an image.
           Recorded because a captured signature and a scanned one are different
           kinds of evidence, and the audit trail should not have to guess. */
        CaptureMethod    VARCHAR(20)     NOT NULL CONSTRAINT DF_UserSig_CaptureMethod DEFAULT ('Drawn'),
        IsActive         BIT             NOT NULL CONSTRAINT DF_UserSig_IsActive DEFAULT (1),
        CreatedAt        DATETIME2(3)    NOT NULL CONSTRAINT DF_UserSig_CreatedAt DEFAULT (SYSUTCDATETIME()),
        UpdatedAt        DATETIME2(3)    NOT NULL CONSTRAINT DF_UserSig_UpdatedAt DEFAULT (SYSUTCDATETIME()),

        CONSTRAINT PK_UserSignatures PRIMARY KEY CLUSTERED (UserSignatureId),
        CONSTRAINT FK_UserSig_Users FOREIGN KEY (UserId) REFERENCES dbo.Users (UserId),
        CONSTRAINT CK_UserSig_CaptureMethod CHECK (CaptureMethod IN ('Drawn', 'Uploaded'))
    );

    /* At most one active signature per user, enforced by the database rather
       than by the service, exactly as UX_EmpSig_Employee_Active does. */
    CREATE UNIQUE NONCLUSTERED INDEX UX_UserSig_User_Active
        ON dbo.UserSignatures (UserId)
        WHERE IsActive = 1;
END
GO

/* -----------------------------------------------------------------------------
   SignaturePlacements.SignerRole / SignerUserId
   SignerRole is what the stamper reads to decide WHICH image to draw.
   'Employee' is the default because it is what every existing placement meant.
   SignerUserId records whose authorising signature was actually drawn, so a
   regenerated PDF reproduces the document that was issued rather than picking
   up whoever happens to be signed in the next time it is rebuilt.
   -------------------------------------------------------------------------- */
IF COL_LENGTH(N'dbo.SignaturePlacements', N'SignerRole') IS NULL
BEGIN
    ALTER TABLE dbo.SignaturePlacements
        ADD SignerRole VARCHAR(20) NOT NULL
            CONSTRAINT DF_SigPlace_SignerRole DEFAULT ('Employee');
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_SigPlace_SignerRole')
BEGIN
    ALTER TABLE dbo.SignaturePlacements
        ADD CONSTRAINT CK_SigPlace_SignerRole CHECK (SignerRole IN ('Employee', 'Authoriser'));
END
GO

IF COL_LENGTH(N'dbo.SignaturePlacements', N'SignerUserId') IS NULL
BEGIN
    ALTER TABLE dbo.SignaturePlacements ADD SignerUserId INT NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_SigPlace_SignerUser')
BEGIN
    ALTER TABLE dbo.SignaturePlacements
        ADD CONSTRAINT FK_SigPlace_SignerUser FOREIGN KEY (SignerUserId)
            REFERENCES dbo.Users (UserId);
END
GO

/* An Authoriser box must name the user who signed it, and an Employee box must
   not: the employee's signature comes from dbo.EmployeeSignatures, so a user id
   on one of those rows would be a claim nothing reads and nobody could trust. */
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_SigPlace_SignerUser')
BEGIN
    ALTER TABLE dbo.SignaturePlacements
        ADD CONSTRAINT CK_SigPlace_SignerUser CHECK (
            (SignerRole = 'Authoriser' AND SignerUserId IS NOT NULL)
            OR
            (SignerRole = 'Employee' AND SignerUserId IS NULL)
        );
END
GO
