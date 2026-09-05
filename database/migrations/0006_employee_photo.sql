/* =============================================================================
   ASPS-DMS  -  0006  Employee photograph
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   A photograph of the employee, so a record has a face against it. Columns on
   dbo.Employees rather than a table of their own: there is exactly one current
   photo per employee and no history to keep, which is the difference from
   dbo.EmployeeSignatures - a signature has to be kept after it is replaced,
   because documents were stamped with it.

   Only the path and what is needed to serve it are stored. The file itself
   lives under the storage root, outside the web root, and is served by an
   authenticated route like every other file here: a photograph of a member of
   staff is not something to leave on a public URL.

   All NULLABLE: every employee on file predates this, and most will never have
   one.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF COL_LENGTH(N'dbo.Employees', N'PhotoFilePath') IS NULL
BEGIN
    ALTER TABLE dbo.Employees ADD
        PhotoFilePath     NVARCHAR(500) NULL,
        PhotoMimeType     VARCHAR(100)  NULL,
        PhotoFileSizeBytes BIGINT       NULL,
        PhotoUploadedAt   DATETIME2(3)  NULL;
END
GO
