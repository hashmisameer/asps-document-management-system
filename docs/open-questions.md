# Open questions and standing assumptions

Anything the company has not confirmed is recorded here rather than silently
invented. Each item says what is blocked by it and what the code currently
assumes, so the assumption is visible instead of buried.

Last updated: 2026-08-31 (signatures, the identity check, and B1 resolved).

---

## Blocking

### B1 - Development database
**Status: RESOLVED on 2026-08-31, by option (a).**

SQL Server 2014 Express (12.0.2000.8 RTM) is installed locally as `.\SQLEXPRESS`
with TCP/IP and mixed-mode authentication enabled. All three migrations and both
seeds have been applied to it, and the signing path driven end to end. No 2014
incompatibility was found.

It is a NAMED instance on a DYNAMIC port, so `backend/.env` sets `DB_INSTANCE`
and lets SQL Server Browser resolve the port; `DB_PORT` must stay unset, because
setting both is ambiguous and `config/env.ts` rejects it.

Options:

| Option | Assessment |
|---|---|
| (a) Install SQL Server 2014 Express/Developer locally | **Recommended.** Matches production exactly, so a 2014 incompatibility fails here rather than on deployment day. |
| (b) A `ASPS_DMS_DEV` database on the company's existing SQL Server 2014 | Also faithful. Needs network access and a dev login from IT. |
| (c) A newer local SQL Server at compatibility level 120 | **Not advised.** Compatibility level does not gate every newer function, so 2016+ syntax can pass locally and fail in production. `npm run check:sql-safety` mitigates but does not eliminate this. |

`npm run db:status` prints the server's version and warns when it is newer
than 2014, so option (c) at least announces itself.

### B2 - The official company document list
**Status: RESOLVED on 2026-08-31.**

All ten document types are seeded, with their deadlines and the details each one
must confirm for the identity check.

**Only the Aadhaar Card and the PAN Card are mandatory. Every other document is
optional.** That was confirmed directly, and it settles what the original sheet
could not: the struck-through marks, the circled (E) and the unmarked Service
Card do not make any of those documents required.

Optional does not mean undated. Every type keeps its own reminder date, so all
ten appear on an employee's checklist with a date to chase, and 'Overdue' still
means overdue. What being optional changes is that a missing one is not a
compliance failure against the employee record.

Seed 0002 first went out with six types marked mandatory, read from those marks.
Because that seed inserts and never updates - deliberately, so it cannot
overwrite a value someone has since changed - a database seeded before this was
not corrected by re-running it. Migration
`0004_mandatory_documents.sql` fixes the databases that already exist; the seed
is corrected for the ones created from here on.

Still open, and much smaller: `RequiresSignature` is an assumption, set to 1 for
the company's own forms and 0 for the two identity cards. It is one value per
row in the seed if any of them is wrong.

### B3 - Windows Server version on the production server
**Status: OPEN. Affects dependency choices now, not at deployment.**

If the production server runs **Windows Server 2012 R2** - plausible alongside
SQL Server 2014 - then modern Node will not run there; the practical ceiling is
Node 16. That would force different choices for several dependencies, so it is
much cheaper to know now than to discover during Milestone 6.

Windows Server 2016 or newer: no problem.

Current state: `.nvmrc` pins Node 22 and `engines.node` is `>=20`, chosen
conservatively. Development is on Node 24.20.0.

---

## Needed before the milestone that uses them

| Ref | Question | Needed by | Current assumption |
|---|---|---|---|
| Q4 | SQL Server instance name, host/IP, port, auth mode (SQL login vs Windows Auth) | M1 completion | `.env.example` placeholders. **Never send credentials in chat** - fill `backend/.env` locally. |
| Q5 | Production `DOCUMENT_STORAGE_PATH`, and whether that volume is backed up | **NOW** | Dev default `./.local-storage`; never hard-coded anywhere. Documents are written there from this milestone on, so the volume and its backup are needed before go-live, not at it. |
| Q6 | May Viewers **download** documents, or preview only? | **NOW** | **Preview only.** Section 6 omits download for Viewers while Section 38 lists it for HR. To change: add `DOCUMENT_DOWNLOAD` to `VIEWER_PERMISSIONS` in `shared/src/constants/roles.ts`; nothing else changes. |
| Q7 | "Due Soon" threshold | M3 | **7 days.** `DEFAULT_DUE_SOON_THRESHOLD_DAYS`; becomes an `AppSettings` row in M5. |
| Q8 | For a JPG/PNG document needing a signature, should the processed output be a PDF or a stamped image? | **IMPLEMENTED** | **PDF**, for one consistent output format. An image document becomes a one-page PDF sized to the image. Reversing this now means changing signatureStamp.service.ts only. |
| Q9 | Should a signed document carry a visible footer (e.g. "Signed via ASPS-DMS, date, user")? | **IMPLEMENTED** | **No.** The signature image is the only thing drawn on the page. Adding a footer later is one more draw call in the stamper. |
| Q10 | Server hostname/IP, bind port, HTTPS internally?, who administers firewall rules | M6 | Not assumed. |
| Q11 | The 5 initial usernames and their roles | M2 | Not assumed. **Names and roles only, no passwords.** Accounts are created with `npm run db:create-user`, which prints a temporary password once and always sets `MustChangePassword`, so the first login forces a change. |
| Q12 | Backup policy for the database and the storage folder: owner and schedule | M6 | Not assumed. |
| Q13 | Somewhere on the company server to put the Tesseract language data, and who puts it there | **NOW** | Not assumed. The server has no route to the internet, so `tesseract.js` cannot fetch `eng.traineddata` on first use and **every OCR pass fails** - which means every scanned document reaches HR as an identity check that could not be read. The files are vendored into a folder and pointed at with `TESSERACT_LANG_PATH`, `TESSERACT_CORE_PATH` and `TESSERACT_CACHE_PATH` (see `backend/.env.example`). PDFs carrying their own text layer are unaffected. |
| Q14 | May any HR user override a failed identity check, or only an Admin? | **NOW** | **Any user who may upload.** The person holding the document is the one who can see whether a poor scan is genuine, and a refusal that only an Admin can clear would stop the day's filing. Every override is stored on the document with its reason and its author, so the control is accountability rather than gatekeeping. To change: require `DOCUMENT_REPLACE` or a new permission in `runIdentityCheck` in document.service.ts. |

---

## Standing assumptions

Stated rather than silently adopted. Each is cheap to reverse if wrong.

1. **Timestamps** are stored UTC (`DATETIME2`, `SYSUTCDATETIME()`) and rendered
   in server-local time. Calendar values (`JoiningDate`, `DueDate`) are `DATE`,
   so no timezone conversion can shift them.
2. **Employees and documents are archived, never hard-deleted** (`IsActive = 0`).
3. **Documents are replaced, not versioned.** The previous file stays on disk and
   in the audit log, but only the current one is served. Full version history is
   a different design - say so if it is needed.
4. **Overdue is derived, never stored.** Computed from `DueDate` at read time, so
   it is correct the moment it is looked at and needs no scheduled job.
5. **`DocumentStatus` and `SignatureStatus` are separate columns.** A document can
   legitimately be `Verified` + `Skipped`.
6. **In-app notifications only.** No email, SMS or WhatsApp (Section 81).
7. **No Active Directory / LDAP / Entra ID.** Local `Users` table only (Section 84).
8. **Detection is advisory.** No code path applies a signature from an OCR/CV
   result without an explicit HR confirmation.
9. **Session and lockout policy**, none of which the specification fixes:
   sessions expire after 8 hours idle under a 24 hour absolute ceiling
   (`SESSION_IDLE_TTL_MINUTES`, `SESSION_ABSOLUTE_TTL_HOURS`), and five failed
   sign-ins lock an account for 15 minutes (`backend/src/config/security.ts`).
   The lockout values are code, not configuration, on purpose: an operator
   should not be able to switch off account lockout by editing `.env`.
10. **A password change ends every other session** for that account and issues a
   fresh one for the device making the change, so whoever prompted the change
   is signed out immediately without the user having to sign in again.
11. **A checklist is materialised when the employee is created**, from the
   document types active at that moment. A type added later therefore does not
   appear on existing employees' checklists on its own: whatever backfills them
   ships with document type management, and until then the seed is the only way
   types are added - before the employees are.
12. **Archive and restore are idempotent.** Archiving an already archived
   employee writes nothing and audits nothing, so a repeated click cannot fill
   the audit trail with events that did not happen.
13. **A replaced file is left on disk** and the row is updated in place, so
   DocumentId - which signature placements and the audit trail refer to - stays
   stable. Only the current file is ever served; the previous one is still there
   if a replacement turns out to have been a mistake. Nothing prunes those yet:
   a retention policy belongs with the backup policy (Q12).
14. **Uploads are held in memory, not spooled to a temporary file.** The file
   has to be read end to end anyway to sniff its type and hash it, and a
   temporary file would leave an unencrypted copy of an employee's document in
   the system temp folder that nothing here is responsible for cleaning up.
15. **Replacing an employee's signature does not re-stamp documents already
   signed.** They carry the image that was current when they were issued;
   silently changing a signature on a document that has already gone out is not
   something this system should decide on its own. Re-signing is a deliberate
   act: open the document and save its placements again.
16. **Processed files are written as new files, never over the previous one.**
   A browser displaying the old copy keeps a valid file underneath it, and the
   earlier output stays inspectable if a placement turns out to have been wrong.
   Like replaced originals (13), nothing prunes them yet.
17. **A document type with no required fields is not identity-checked.** The
   fields a document must confirm are configuration, so a type nobody has
   configured is filed as it always was rather than being refused for details
   nobody asked for. A check that did not run is stored as `NotChecked`, which
   is deliberately a different answer from one that ran and passed.
