/* =============================================================================
   ASPS-DMS  -  0039  The PAN card may be set aside for one employee
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   0028 opened this for the ESIC form alone and said the next one - when the
   office asked - should be an UPDATE rather than a deployment. The office has
   asked, and it is the PAN card: so this is that UPDATE, and nothing else.

   THIS REVERSES 0028 FOR PAN, DELIBERATELY. 0028 named the PAN card with Form
   16 and the appointment letter as statutory - documents nobody here decides do
   not apply to somebody - and closed all three on purpose. The reason it is
   being reopened for PAN is contract staff: they do not have a PAN card, so the
   row is chased, goes overdue, and sits in the daily reminder for a document
   that will never arrive. Form 16 and the appointment letter STAY CLOSED;
   0028's reasoning still holds for them, and this file names PAN_CARD and
   touches no other row.

   What it means on screen is what it already means for the ESIC form: HR may
   mark the PAN card 'not required' for ONE employee, and it leaves that
   employee's counts and the overdue list. Who did it and when are recorded
   (NotRequiredBy, NotRequiredAt); there is no typed reason to give.

   0028's last statement closes every type but ESIC, which would undo this if it
   ran again - it will not: a migration is applied once and the ledger's
   checksum holds it there. Anybody re-running that file by hand should run this
   one after it.
   ============================================================================= */

SET NOCOUNT ON;
GO

UPDATE dbo.DocumentTypes
   SET CanBeMarkedNotRequired = 1, UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode = 'PAN_CARD' AND CanBeMarkedNotRequired = 0;
GO
