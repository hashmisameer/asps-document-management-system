/* =============================================================================
   Seed 0003 - Departments and designations

   From the attendance export of 29 August 2026 (568 employee rows): 26
   departments and 49 designations.

   The values are reproduced EXACTLY as they appear in that file, including the
   spellings that look like data-entry slips. That is deliberate, and it is not
   an endorsement of them:

     - the identity check compares the designation printed on a service card
       with the one on the record, and those cards are printed from this same
       data. 'ASSTT.OPERATER' on the card must find 'ASSTT.OPERATER' on the
       record, or every upload for 146 people needs an override;
     - the 568 employees still to be imported carry these strings. Correcting a
       spelling here without correcting it there splits one designation into two.

   KNOWN INCONSISTENCIES, to be settled with HR and then fixed in ONE migration
   that updates the list and the employee rows together:

     SUPERVISIOR  ASSTT MAINTENANCE / PRESSING / QUALITY SUPERVISIOR and
                  ASSTT.SUPERVISIOR use it; a correctly spelled SUPERVISOR also
                  exists, which is why both are in this list.
     OPERATER     ASSTT.OPERATER, FUSING OPERATER, OPERATER end in ER;
                  SAMPLING OPERATOR ends in OR.
     ASSTT.       Some carry the full stop, some do not.
     PRESS MAN    Spaced here, joined in ASSTT.PRESSMAN and SAMPLING PRESSMAN.
     CHECHE       Almost certainly CRECHE CARE TAKER.
     ASSEMBLY     Jacket uses a hyphen, trouser uses a space.
     MAINTENANCE  One employee, alongside MACHINE and ELECTRICITY MAINTENANCE.

   Idempotent: matches on Name, so re-running adds nothing and overwrites
   nothing an administrator has since deactivated.
   ============================================================================= */

SET NOCOUNT ON;
GO

MERGE dbo.Departments AS target
USING (VALUES
    (N'ADMIN'), (N'CAD'), (N'CUTTING'), (N'ELECTRICITY MAINTENANCE'),
    (N'FABRIC STORE'), (N'FUSING'), (N'HR DEPTT'), (N'JACKET ASSEMBLY-1'),
    (N'JACKET ASSEMBLY-2'), (N'JACKET FINISHING'), (N'JACKET FRONT'),
    (N'JACKET LINING'), (N'JACKET PRODUCTION'), (N'JACKET SLEEVE'),
    (N'JACKET WAREHOUSE'), (N'MACHINE MAINTENANCE'), (N'MAINTENANCE'),
    (N'TRIMS STORE'), (N'TROUSER ASSEMBLY 1'), (N'TROUSER ASSEMBLY 2'),
    (N'TROUSER BACK'), (N'TROUSER FINISHING'), (N'TROUSER FRONT'),
    (N'TROUSER PREPARATORY'), (N'TROUSER PRODUCTION'), (N'TROUSER WAREHOUSE')
) AS source (Name)
    ON target.Name = source.Name
WHEN NOT MATCHED BY TARGET THEN
    INSERT (Name, IsActive) VALUES (source.Name, 1);
GO

MERGE dbo.Designations AS target
USING (VALUES
    (N'ACCOUNTANT'), (N'ASSTT CHECKER'), (N'ASSTT ELECTRICIAN'),
    (N'ASSTT MAINTENANCE SUPERVISIOR'), (N'ASSTT PRESSING SUPERVISIOR'),
    (N'ASSTT QUALITY SUPERVISIOR'), (N'ASSTT.OPERATER'), (N'ASSTT.PRESSMAN'),
    (N'ASSTT.SUPERVISIOR'), (N'CAD TECHNICIAN'), (N'CHECHE CARE TAKER'),
    (N'CO-ORDINATOR'), (N'CUTTING MASTER'), (N'DARNER'), (N'DRIVER'),
    (N'ELECTRICITY TECHNICIAN'), (N'ERP'), (N'FUSING HELPER'),
    (N'FUSING OPERATER'), (N'HELPER'), (N'HR EXECUTIVE'), (N'LADY GUARD'),
    (N'LAYER MAN'), (N'LAYERING HELPER'), (N'MACHINE TECHNICIAN'), (N'MANAGER'),
    (N'MANAGER-HR & COMPLIANCE'), (N'MARKING HELPER'), (N'MATERIAL HANDLER'),
    (N'MERCHANDISER'), (N'OPERATER'), (N'PACKING HANDLER'), (N'PANTRY'),
    (N'PRESS MAN'), (N'PRESSING HELPER'), (N'PRESSING TECHNICIAN'), (N'Q.C'),
    (N'QUALITY HEAD'), (N'QUALITY HELPER'), (N'SAMPLING HEAD'),
    (N'SAMPLING OPERATOR'), (N'SAMPLING PRESSMAN'), (N'SAMPLING TAILOR'),
    (N'SECURITY'), (N'SHIPPING'), (N'STICKERMAN'), (N'SUPERVISOR'),
    (N'TECHNICIAN'), (N'THREAD CUTTER')
) AS source (Name)
    ON target.Name = source.Name
WHEN NOT MATCHED BY TARGET THEN
    INSERT (Name, IsActive) VALUES (source.Name, 1);
GO
