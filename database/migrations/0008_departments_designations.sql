/* =============================================================================
   ASPS-DMS  -  0008  Departments and designations
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   Department and designation were free text on dbo.Employees, typed by hand for
   every employee. Across 568 people that guarantees drift - JACKET FRONT and
   Jacket Front and JACKET  FRONT are three departments to a computer and one to
   a person - and the identity check compares the designation printed on a
   service card with the one on the record, so a typo there becomes a refused
   document.

   Two lookup tables, seeded from the attendance export of 29 August 2026.

   The columns on dbo.Employees stay as they are, holding the NAME rather than a
   foreign key. Renaming a department should not rewrite every employee row, and
   more importantly a document already printed carries the old name: the record
   has to keep saying what the card says.

   IsActive rather than deletion, so a department that closes stops being
   offered without erasing the employees who worked in it.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF OBJECT_ID(N'dbo.Departments', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Departments
    (
        DepartmentId INT            NOT NULL IDENTITY(1,1),
        Name         NVARCHAR(100)  NOT NULL,
        IsActive     BIT            NOT NULL CONSTRAINT DF_Departments_IsActive DEFAULT (1),
        CreatedAt    DATETIME2(3)   NOT NULL CONSTRAINT DF_Departments_CreatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_Departments PRIMARY KEY CLUSTERED (DepartmentId),
        CONSTRAINT UQ_Departments_Name UNIQUE (Name)
    );
END
GO

IF OBJECT_ID(N'dbo.Designations', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Designations
    (
        DesignationId INT           NOT NULL IDENTITY(1,1),
        Name          NVARCHAR(100) NOT NULL,
        IsActive      BIT           NOT NULL CONSTRAINT DF_Designations_IsActive DEFAULT (1),
        CreatedAt     DATETIME2(3)  NOT NULL CONSTRAINT DF_Designations_CreatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_Designations PRIMARY KEY CLUSTERED (DesignationId),
        CONSTRAINT UQ_Designations_Name UNIQUE (Name)
    );
END
GO
