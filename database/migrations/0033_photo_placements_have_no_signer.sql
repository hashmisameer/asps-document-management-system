/* =============================================================================
   ASPS-DMS  -  0033  A photograph box names no signer
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   0032 let a placement carry the employee's photograph by widening
   CK_SigPlace_SignerRole to three values. It missed the constraint beside it.
   0002 also added CK_SigPlace_SignerUser, which says an Authoriser box must
   name the user who signed it and an Employee box must not:

       (SignerRole = 'Authoriser' AND SignerUserId IS NOT NULL)
    OR (SignerRole = 'Employee'   AND SignerUserId IS NULL)

   A row whose SignerRole is 'Photo' satisfies neither branch, whatever its
   SignerUserId, so every photograph placement was refused by the database at
   the INSERT - a 500 on the signing screen, with the transaction rolled back
   and nothing written. This adds the third branch: a photograph is nobody's
   signature, so it names no signer.

   0032 is applied and checksummed, so it is not edited; the explanation lives
   here. Idempotent, in the same style: the constraint is rebuilt only while
   its definition still says nothing about 'Photo'.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints
            WHERE name = N'CK_SigPlace_SignerUser'
              AND definition NOT LIKE '%Photo%')
BEGIN
    ALTER TABLE dbo.SignaturePlacements DROP CONSTRAINT CK_SigPlace_SignerUser;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_SigPlace_SignerUser')
BEGIN
    ALTER TABLE dbo.SignaturePlacements
        ADD CONSTRAINT CK_SigPlace_SignerUser CHECK (
            (SignerRole = 'Authoriser' AND SignerUserId IS NOT NULL)
            OR
            (SignerRole = 'Employee' AND SignerUserId IS NULL)
            OR
            (SignerRole = 'Photo' AND SignerUserId IS NULL)
        );
END
GO
