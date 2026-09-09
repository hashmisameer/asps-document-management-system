/* =============================================================================
   ASPS-DMS  -  0026  An unreadable identity card is no longer thrown away
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   0019 set RefuseOnCheckFailure on the Aadhaar and PAN rows, on the office's
   instruction of 2026-09-02 that a card whose name does not match should not be
   uploaded at all. In practice that meant: the file is stored, read a few
   seconds later, and then DELETED again - the row falling back to Pending while
   whoever uploaded it was already looking at the next screen.

   What has been learned since is that the premise was wrong. All ~550
   employees' PAN and Aadhaar documents at this company are low-contrast JPG
   photocopies, and OCR failing to read a name off one is the ORDINARY case, not
   a sign that anything is wrong with the document. The rule was written for the
   rare bad filing and was being applied, hundreds of times, to good paperwork -
   each time demanding that somebody type a sentence explaining a photocopier.

   So the flag goes off. The document is always kept, whatever the reading says,
   and the row carries one of three answers a person can act on:

       Passed      the name was found and matched
       Failed      it was not - a yellow warning, and a one-click confirmation
       Overridden  somebody looked at the page and confirmed it

   NO SCHEMA CHANGE. The column stays exactly as it is, because which document
   types are treated this way remains an office decision that belongs in this
   table rather than in the code - and if the office ever wants the old rule
   back for some type, that is an UPDATE and not a deployment.

   Nothing that has already happened is rewritten. Documents refused in the past
   are already gone from their rows; this only changes what happens next.
   ============================================================================= */

SET NOCOUNT ON;
GO

UPDATE dbo.DocumentTypes
   SET RefuseOnCheckFailure = 0, UpdatedAt = SYSUTCDATETIME()
 WHERE RefuseOnCheckFailure = 1;
GO
