/* =============================================================================
   ASPS-DMS  -  0020  The employee's address
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The office asked for a phone number and an address on the employee record.
   The phone number has been there since 0001; the address has not.

   NULLABLE, and it has to be. There are 568 employees already on file with no
   address recorded anywhere, and a NOT NULL column would either refuse to be
   added or fill every one of them with an invented blank. The FORM requires it
   of a new employee; the column records that an old one was entered before
   anybody was asked for it.

   Long enough for a full Indian postal address written the way people write one,
   including the village and district lines that appear on these forms.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF COL_LENGTH(N'dbo.Employees', N'Address') IS NULL
BEGIN
    ALTER TABLE dbo.Employees ADD Address NVARCHAR(500) NULL;
END
GO
