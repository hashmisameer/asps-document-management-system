/* =============================================================================
   ASPS-DMS  -  0023  Deadlines for the identity cards already on the checklist
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   0022 gave the Aadhaar card and the PAN card a seven-day deadline. That
   changes the document TYPE, and a type's deadline is only read when a
   checklist row is created - so every employee already on file kept a row
   saying 'No deadline', and would have gone on doing so for ever.

   The office asked for these two to be tracked like every other document.
   A row that can never be late is not tracked; it is listed.

   ONLY rows with nothing attached yet. A card that has already arrived is not
   waiting for anybody, and writing a due date onto it would put a date on the
   record that never applied to it.

   EXPECT THESE TO READ AS OVERDUE IMMEDIATELY, and that is correct rather than
   alarming: the date is seven days after the employee joined, and for anybody
   who joined more than a week ago that day has passed. The document really is
   outstanding, and has been. It was simply not being counted.
   ============================================================================= */

SET NOCOUNT ON;
GO

UPDATE d
   SET d.DueDate   = DATEADD(DAY, 7, e.JoiningDate),
       d.UpdatedAt = SYSUTCDATETIME()
  FROM dbo.EmployeeDocuments AS d
 INNER JOIN dbo.Employees AS e ON e.EmployeeId = d.EmployeeId
 INNER JOIN dbo.DocumentTypes AS dt ON dt.DocumentTypeId = d.DocumentTypeId
 WHERE d.IsActive = 1
   AND d.OriginalFilePath IS NULL
   AND d.DueDate IS NULL
   AND dt.DocumentCode IN ('AADHAAR_CARD', 'PAN_CARD');
GO
