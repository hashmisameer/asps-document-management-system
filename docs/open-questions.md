# Open questions and standing assumptions

Anything the company has not confirmed is recorded here rather than silently
invented. Each item says what is blocked by it and what the code currently
assumes, so the assumption is visible instead of buried.

Last updated: 2026-08-30 (end of Milestone 1).

---

## Blocking

### B1 - Development database
**Status: OPEN. Blocks the rest of Milestone 1.**

No SQL Server instance is installed on the development laptop (no `MSSQL*`
services, no `sqlcmd`). The schema and migration runner are written and
typechecked, but nothing has been executed against a real server.

Options:

| Option | Assessment |
|---|---|
| (a) Install SQL Server 2014 Express/Developer locally | **Recommended.** Matches production exactly, so a 2014 incompatibility fails here rather than on deployment day. |
| (b) A `ASPS_DMS_DEV` database on the company's existing SQL Server 2014 | Also faithful. Needs network access and a dev login from IT. |
| (c) A newer local SQL Server at compatibility level 120 | **Not advised.** Compatibility level does not gate every newer function, so 2016+ syntax can pass locally and fail in production. `npm run check:sql-safety` mitigates but does not eliminate this. |

`npm run db:status` prints the server's version and warns when it is newer
than 2014, so option (c) at least announces itself.

### B2 - The official company document list
**Status: OPEN. Blocks Milestone 2 (document type configuration).**

`database/seeds/0002_document_types.sql` currently seeds **PAN Card only**,
which is the one confirmed rule (PAN Card = MANDATORY). Every document marked
"M" on the official list must be `IsMandatory = 1`, everything else `0`.

Needed: document names and their M markings. **Document names only - no real
employee data, no scans, no PAN or Aadhaar numbers.**

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
| Q5 | Production `DOCUMENT_STORAGE_PATH`, and whether that volume is backed up | M3 | Dev default `./.local-storage`; never hard-coded anywhere. |
| Q6 | May Viewers **download** documents, or preview only? | M2 | **Preview only.** Section 6 omits download for Viewers while Section 38 lists it for HR. To change: add `DOCUMENT_DOWNLOAD` to `VIEWER_PERMISSIONS` in `shared/src/constants/roles.ts`; nothing else changes. |
| Q7 | "Due Soon" threshold | M3 | **7 days.** `DEFAULT_DUE_SOON_THRESHOLD_DAYS`; becomes an `AppSettings` row in M5. |
| Q8 | For a JPG/PNG document needing a signature, should the processed output be a PDF or a stamped image? | M4 | **PDF**, for one consistent output format. |
| Q9 | Should a signed document carry a visible footer (e.g. "Signed via ASPS-DMS, date, user")? | M4 | **No.** Signature image only; nothing else drawn on the page. |
| Q10 | Server hostname/IP, bind port, HTTPS internally?, who administers firewall rules | M6 | Not assumed. |
| Q11 | The 5 initial usernames and their roles | M2 | Not assumed. **Names and roles only, no passwords** - first login forces a password change. |
| Q12 | Backup policy for the database and the storage folder: owner and schedule | M6 | Not assumed. |

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
