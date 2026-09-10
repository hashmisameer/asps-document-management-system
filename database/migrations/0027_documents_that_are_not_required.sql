/* =============================================================================
   ASPS-DMS  -  0027  A document that is not required of THIS employee
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   ESIC does not apply to everybody. Neither, in time, will PF. Until now the
   checklist had no way to say so: every employee was expected to produce all
   ten documents, so an employee who legitimately owed nine could never read as
   complete, and the one nobody would ever collect sat in the outstanding count,
   went overdue, and turned up in the daily chase email for ever.

   The decision belongs to the EMPLOYEE'S ROW, not to the document type. ESIC is
   not optional in general - it is not applicable to this person - and the next
   request will be the same thing for PF. A per-type flag would have to be
   changed for everybody at once, which is a different and wrong answer.

   TWO NULLABLE COLUMNS, AND NOTHING ELSE TOUCHED.

     NotRequiredAt   when the decision was made. NULL - which is what every
                     existing row has - means the document is expected, so
                     nothing about the system changes until somebody uses this.

     NotRequiredBy   who made it. A row that quietly stopped being chased with
                     nobody's name on it is not a record, it is a gap.

   Deliberately NOT a sixth value of Status. Status is bounded by two CHECK
   constraints and is read by the state machine, the badges and half a dozen
   filters; a value added there would have to be understood by all of them. And
   'not required' is not a stage a document passes through on its way to being
   filed - it is a statement that this document has no journey.

   No reason column. The office asked for one button.

   The DueDate is left exactly where it is. Undoing this puts the document back
   to Pending with the deadline it always had, rather than inventing a new one.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF COL_LENGTH(N'dbo.EmployeeDocuments', N'NotRequiredAt') IS NULL
BEGIN
    ALTER TABLE dbo.EmployeeDocuments ADD NotRequiredAt DATETIME2(3) NULL;
END
GO

IF COL_LENGTH(N'dbo.EmployeeDocuments', N'NotRequiredBy') IS NULL
BEGIN
    ALTER TABLE dbo.EmployeeDocuments ADD NotRequiredBy INT NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_EmpDocs_NotRequiredBy')
BEGIN
    ALTER TABLE dbo.EmployeeDocuments
        ADD CONSTRAINT FK_EmpDocs_NotRequiredBy FOREIGN KEY (NotRequiredBy)
            REFERENCES dbo.Users (UserId);
END
GO

/* Both or neither. A date with no name behind it would be a document that
   stopped being chased and nobody to ask about it. */
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_EmpDocs_NotRequired')
BEGIN
    ALTER TABLE dbo.EmployeeDocuments
        ADD CONSTRAINT CK_EmpDocs_NotRequired CHECK (
            (NotRequiredAt IS NULL AND NotRequiredBy IS NULL)
            OR (NotRequiredAt IS NOT NULL AND NotRequiredBy IS NOT NULL)
        );
END
GO

/* Every count in the application filters on this column, and on a table with a
   row per employee per document type - 5,490 today - it is worth an index that
   lets the common case (nothing marked) be answered without reading them all. */
IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = N'IX_EmpDocs_NotRequiredAt'
                  AND object_id = OBJECT_ID(N'dbo.EmployeeDocuments'))
BEGIN
    CREATE NONCLUSTERED INDEX IX_EmpDocs_NotRequiredAt
        ON dbo.EmployeeDocuments (NotRequiredAt)
        INCLUDE (EmployeeId, DocumentTypeId);
END
GO
