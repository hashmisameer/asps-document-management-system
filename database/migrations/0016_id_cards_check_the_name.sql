/* =============================================================================
   ASPS-DMS  -  0016  The two ID cards are checked for the employee's name
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The office asked, on 2026-09-02, that the Aadhaar card and the PAN card be
   checked on whether the employee's name matches, and refused where it does not.

   This reverses the field half of 0012, which took every check off these two.
   Two things have changed since, and both bear on it:

     - A name the scan runs together now matches. The gratuity form came back
       reading 'BHAGWANSINGH' and was refused for not naming the employee; names
       are now compared with the gaps closed as well as open.

     - Finding the name is now sufficient on its own. A card no longer has to
       satisfy every field to be accepted, so the name is the whole test.

   The recognition keywords stay OFF. 0012 removed those on evidence that has not
   changed - a photographed PAN card read as 2,173 characters of noise, so the
   card could not be recognised as a PAN card - and the office asked for a name
   check, not for that one back.

   WHAT THIS WILL DO, measured on the cards already in the system on the day it
   was written: both are refused. The Aadhaar image is 700x440 and gives no
   readable words; the PAN photograph gives 2,173 characters that include
   'TRASH', 'FERAL' and 'RODENT' and nothing of the name. Tesseract's own
   orientation detection refuses both with 'Too few characters', so they are not
   sideways - they are unreadable, and a clearer photograph is what fixes them.

   Refused is not blocked. The upload comes back with the reason and the person
   holding the card accepts it, which is recorded against the document under
   their name. Creating an employee is unaffected either way: that flow leaves a
   failed upload pending on the checklist rather than refusing the employee.
   ============================================================================= */

SET NOCOUNT ON;
GO

UPDATE dbo.DocumentTypes
   SET RequiredFields = N'EmployeeName', UpdatedAt = SYSUTCDATETIME()
 WHERE DocumentCode IN ('AADHAAR_CARD', 'PAN_CARD');
GO
