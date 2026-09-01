/* =============================================================================
   ASPS-DMS  -  0007  Employee gender
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   Form-V, the service card, records GENDER, and the office needs the headcount
   split by it. There was nowhere to keep it.

   NULLABLE, and it stays nullable. Every employee already on file predates the
   column, and a NOT NULL column would either block the migration or invent an
   answer for a real person. 'Not recorded' is a truthful answer and the
   dashboard reports it as its own number rather than folding it into either
   side, which would misstate a count somebody may act on.

   A CHECK rather than a lookup table: this is a short fixed list, and a join
   for three values buys nothing.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF COL_LENGTH(N'dbo.Employees', N'Gender') IS NULL
BEGIN
    ALTER TABLE dbo.Employees ADD Gender VARCHAR(10) NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_Employees_Gender')
BEGIN
    ALTER TABLE dbo.Employees WITH NOCHECK
        ADD CONSTRAINT CK_Employees_Gender CHECK (
            Gender IS NULL OR Gender IN ('Male', 'Female', 'Other')
        );
END
GO
