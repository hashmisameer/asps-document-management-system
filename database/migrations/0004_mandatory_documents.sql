/* =============================================================================
   ASPS-DMS  -  0004  Only the two identity cards are mandatory
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   Open question B2 is answered: of the ten document types, ONLY the Aadhaar
   Card and the PAN Card are mandatory. Every other document is optional.

   Seed 0002 first went out with six types marked mandatory, read from the marks
   on the original sheet - some struck through, one circled, one absent - which
   is exactly the ambiguity B2 recorded. Those marks turned out not to mean
   required at all.

   This is a MIGRATION rather than a corrected seed because seed 0002 inserts
   and never updates: it deliberately will not overwrite a value someone has
   since changed, so re-running it leaves an already-seeded database wrong. The
   seed is corrected too, for databases created from here on; this fixes the
   ones that already exist.

   Wrongly mandatory is not a cosmetic error. It puts a false 'missing' against
   every employee for a document nobody was ever required to produce, and the
   whole point of the checklist is to say what is actually outstanding.

   WHAT THIS DOES NOT TOUCH
   Deadlines. Every type keeps its own reminder date, optional or not, so each
   one still appears on the checklist with a date to chase. Optional means a
   missing document is not a compliance failure - it does not mean undated, and
   this migration changes no DeadlineValue or DeadlineUnit.

   Nor does it touch any employee's documents. IsMandatory lives on the TYPE and
   is read through a join, so every checklist row already written picks up the
   corrected value with no rewrite of dbo.EmployeeDocuments.

   Idempotent: it sets values rather than toggling them, so running it twice
   leaves the same state.
   ============================================================================= */

SET NOCOUNT ON;
GO

/* The two identity cards: mandatory. */
UPDATE dbo.DocumentTypes
   SET IsMandatory = 1
 WHERE DocumentCode IN ('AADHAAR_CARD', 'PAN_CARD')
   AND IsMandatory <> 1;
GO

/* Everything else: optional.

   Written as "every code that is not one of the two" rather than as a list of
   the four that were wrong, so a type added later by any route cannot quietly
   stay mandatory without someone deciding that it should be. */
UPDATE dbo.DocumentTypes
   SET IsMandatory = 0
 WHERE DocumentCode NOT IN ('AADHAAR_CARD', 'PAN_CARD')
   AND IsMandatory <> 0;
GO
