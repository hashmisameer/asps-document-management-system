/* =============================================================================
   ASPS-DMS  -  0021  The employee's email address
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   Asked for alongside the phone number and address, as the third thing anybody
   needs when they have to reach somebody.

   NULLABLE. The 568 employees already on file have no email recorded, and most
   of them will never have one - this is a factory, and the office reaches its
   workmen by telephone. The form asks for it and accepts nothing; the column
   records that most of the time there is nothing to record.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF COL_LENGTH(N'dbo.Employees', N'Email') IS NULL
BEGIN
    ALTER TABLE dbo.Employees ADD Email NVARCHAR(200) NULL;
END
GO
