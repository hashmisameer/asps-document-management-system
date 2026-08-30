/* =============================================================================
   Seed 0001 - Roles

   Idempotent: safe to re-run. These three roles match ROLE_PERMISSIONS in
   shared/src/constants/roles.ts. Adding a role later means adding a row here
   plus an entry in that map - no route or component changes.
   ============================================================================= */

SET NOCOUNT ON;
GO

MERGE dbo.Roles AS target
USING (VALUES
    ('HR',     N'Operational access: employees, documents, deadlines, signatures, reports, audit'),
    ('VIEWER', N'Management / viewer. Read-only: dashboard, employees, document preview, reports'),
    ('ADMIN',  N'HR permissions plus user management')
) AS source (RoleName, Description)
    ON target.RoleName = source.RoleName
WHEN NOT MATCHED BY TARGET THEN
    INSERT (RoleName, Description) VALUES (source.RoleName, source.Description)
WHEN MATCHED AND ISNULL(target.Description, N'') <> source.Description THEN
    UPDATE SET Description = source.Description;
GO
