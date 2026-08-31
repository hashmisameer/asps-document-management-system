/* =============================================================================
   ASPS-DMS  -  0005  Self-registration, and the cap on it
   Target: Microsoft SQL Server 2014  (compatibility level 120)

   The sign-in page now has a way in for the office's own staff: a registration
   form, limited to a fixed number of accounts, after which it closes for good.

   WHY THE COLUMN EXISTS
   The cap has to be counted somewhere, and it has to be counted here rather
   than in the browser or in a service that reads a count and then writes - two
   people registering at the same moment would both read four and both insert,
   making six. Marking the row lets the INSERT itself carry the condition, so
   the check and the write are one statement and the database decides.

   It also answers a question the audit trail otherwise could not: whether an
   account was handed out by an administrator or enrolled by whoever reached the
   form first. Those are different acts and they read differently months later.

   Accounts made with db:create-user leave this 0 and do not consume a slot: an
   Admin adding a colleague on purpose is not the thing being limited.

   DEFAULT 0, NOT NULL: every account that exists today was created by an
   administrator, which is exactly what 0 means, so there is no backfill and no
   row left ambiguous.
   ============================================================================= */

SET NOCOUNT ON;
GO

IF COL_LENGTH(N'dbo.Users', N'IsSelfRegistered') IS NULL
BEGIN
    ALTER TABLE dbo.Users
        ADD IsSelfRegistered BIT NOT NULL
            CONSTRAINT DF_Users_IsSelfRegistered DEFAULT (0);
END
GO

/* NO INDEX HERE, deliberately.

   A filtered index on this column would make counting the registered accounts a
   seek. It would also make EVERY insert, update and delete on dbo.Users require
   SET QUOTED_IDENTIFIER ON, because SQL Server refuses DML against a table with
   a filtered index under the wrong SET options - and sqlcmd connects with it
   OFF by default. That turns an ordinary bit of maintenance at a console into a
   confusing failure, in exchange for speeding up a COUNT over a handful of rows
   on a table that will never hold more than a few. Not worth it. */
