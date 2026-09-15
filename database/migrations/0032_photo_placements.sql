/* =============================================================================
   ASPS-DMS  -  0032  A placement may carry the employee's photograph
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The ESIC form prints a box for the employee's photograph. The photograph is
   already on the record - Employees.PhotoFilePath - and the signing screen
   already lets HR drag a box onto a page and say what goes in it: the
   employee's signature, or the authorising user's. This lets that box say
   'Photo' as well.

   ONE COLUMN, ONE MORE VALUE. SignerRole is what the stamper reads to decide
   which image to draw, and 0002 fixed its values with a CHECK constraint. That
   constraint is dropped and put back with the third value. Nothing else in the
   row changes: a photo is placed, sized and recorded exactly as a signature is.

   It is a picture, not a signature. The service marks a document signed only
   when its placements hold a signature; a photograph on its own rebuilds the
   PDF and is kept, and the signature status stays where it was. Which
   documents may carry one is the service's decision too - the ESIC form only,
   today - and is deliberately not written into the database.

   Idempotent: the constraint is rebuilt only while it still names two values.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints
            WHERE name = N'CK_SigPlace_SignerRole'
              AND definition NOT LIKE '%Photo%')
BEGIN
    ALTER TABLE dbo.SignaturePlacements DROP CONSTRAINT CK_SigPlace_SignerRole;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_SigPlace_SignerRole')
BEGIN
    ALTER TABLE dbo.SignaturePlacements
        ADD CONSTRAINT CK_SigPlace_SignerRole
            CHECK (SignerRole IN ('Employee', 'Authoriser', 'Photo'));
END
GO
